/**
 * @module as-graph/engine/runs/GraphRunExecutor
 * @summary Asynchronous graph run execution (DECAF-50 §4.16).
 * @description Schedules runs against the {@link GraphExecutionEngine},
 * mirrors engine events into the run's sequenced SSE stream, enforces run
 * timeouts via per-run `AbortController`s, and finalizes the run's terminal
 * state in the run store. Exactly one execution per `runId` — repeated
 * schedules await the same completion promise.
 */
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import {
  isGraphJsonValue,
  type GraphJsonValue,
  type GraphWorkflowDocument,
} from "../../shared/graph";
import { GraphExecutionError } from "../errors";
import { GraphExecutionEngine } from "../execution/GraphExecutionEngine";
import type {
  GraphExecutionErrorPayload,
  GraphExecutionEvent,
} from "../../shared/graph";
import type {
  GraphExecutionResult,
  GraphExecutionValues,
} from "../types";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../shared/graph";
import { GraphRunEventPublisher } from "./GraphRunEventPublisher";
import type { GraphAuthData } from "../auth";
import { graphRunTimeOf } from "./GraphRunConverters";
import {
  graphRunResultDataOf,
  graphRunResultSummaryOf,
  type GraphRunDataStore,
} from "./GraphRunDataStore";
import { graphMetrics, timedGraphStoreOperation } from "../telemetry/GraphTelemetry";

/**
 * Bytes a finished run occupies: its run data object plus the files it
 * references (each counted once).
 */
function storedBytesOf(data: unknown): number {
  let total = 0;
  try {
    total += Buffer.byteLength(JSON.stringify(data) ?? "");
  } catch {
    // unserializable data was capped already
  }
  const seen = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12 || value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (
      typeof record["id"] === "string" &&
      (record["id"] as string).startsWith("graph-binary:") &&
      typeof record["byteLength"] === "number"
    ) {
      if (!seen.has(record["id"] as string)) {
        seen.add(record["id"] as string);
        total += record["byteLength"] as number;
      }
      return;
    }
    for (const child of Array.isArray(value) ? value : Object.values(record)) {
      visit(child, depth + 1);
    }
  };
  visit(data, 0);
  return total;
}
import {
  DEFAULT_GRAPH_RUN_LIMITS,
  isGraphRunTerminalEventType,
  type GraphRunEventEnvelopeInput,
  type GraphRunLimits,
  type GraphRunStatus,
} from "../../shared/graph";
import {
  type GraphRun,
  type GraphRunStore,
} from "./types";

/** Why a run was aborted: explicit user cancellation or run timeout. */
export type GraphRunAbortReason = "user" | "timeout" | "shutdown";

/** Lifecycle hooks observed by {@link GraphRunExecutor} when a run completes. */
export interface GraphRunExecutionHooks {
  /** Called once a run reaches a terminal state, with its result when successful. */
  onRunCompleted?: (
    run: GraphRun,
    result?: GraphExecutionResult
  ) => Promise<void>;
  /**
   * Where a finished run's full result goes; the run row then keeps only the
   * summary ({@link graphRunResultSummaryOf}).
   */
  runData?: GraphRunDataStore;
}

/**
 * Resolves the canonical document (and its fingerprint) a run executes,
 * accepting an optional Decaf {@link Context} as leading argument.
 */
export type GraphRunDocumentProvider = (
  ...args: MaybeContextualArg<Context>
) => Promise<{ document: GraphWorkflowDocument; fingerprint: string }>;

/**
 * Executes graph runs asynchronously (DECAF-50 §4.16): schedules a run
 * against the {@link GraphExecutionEngine}, mirrors engine events into the
 * run's sequenced SSE stream, enforces run timeouts via per-run
 * `AbortController`s, and finalizes the run's terminal state in the run
 * store. Exactly one execution per `runId` — repeated schedules await the
 * same completion promise.
 */
export class GraphRunExecutor {
  private readonly engine: GraphExecutionEngine;
  private readonly runStore: GraphRunStore;
  private readonly publisher: GraphRunEventPublisher;
  private readonly limits: Required<GraphRunLimits>;
  private readonly hooks: GraphRunExecutionHooks;
  private readonly controllers = new Map<string, AbortController>();
  private readonly completions = new Map<string, Promise<GraphRun>>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** The principal each run executes as. */
  private readonly auth = new Map<string, GraphAuthData>();

  /** Sets the principal a run executes as (from its stored request). */
  setAuth(runId: string, auth: GraphAuthData | undefined): void {
    if (auth) this.auth.set(runId, auth);
  }

  constructor(
    engine: GraphExecutionEngine,
    runStore: GraphRunStore,
    publisher: GraphRunEventPublisher,
    hooks: GraphRunExecutionHooks = {},
    limits: GraphRunLimits = {}
  ) {
    this.engine = engine;
    this.runStore = runStore;
    this.publisher = publisher;
    this.hooks = hooks;
    this.limits = { ...DEFAULT_GRAPH_RUN_LIMITS, ...limits };
  }

  /** Returns (creating if needed) the run's `AbortController`. */
  begin(runId: string): AbortController {
    const existing = this.controllers.get(runId);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return controller;
  }

  /** Aborts the run, if it is still in flight. Returns whether an abort was issued. */
  abort(runId: string, reason: GraphRunAbortReason): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    if (!controller.signal.aborted) controller.abort(reason);
    return true;
  }

  /** Whether the run's abort signal has fired. */
  isAborted(runId: string): boolean {
    return this.controllers.get(runId)?.signal.aborted === true;
  }

  /** The run's abort reason, when aborted. */
  abortReason(runId: string): GraphRunAbortReason | undefined {
    const signal = this.controllers.get(runId)?.signal;
    if (!signal?.aborted) return undefined;
    return signal.reason === "timeout" || signal.reason === "shutdown"
      ? signal.reason
      : "user";
  }

  /** The run's in-flight completion promise, when one is scheduled. */
  waitFor(runId: string): Promise<GraphRun> | undefined {
    return this.completions.get(runId);
  }

  /**
   * Schedules the run for execution and returns its completion promise
   * (deduplicated per `runId`). Engine events are mirrored to the run's SSE
   * stream; failures still emit a terminal event and finalize the run as
   * `failed`.
   */
  schedule(
    run: GraphRun,
    documentProvider: GraphRunDocumentProvider,
    inputs: GraphExecutionValues,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun> {
    const existing = this.completions.get(run.runId);
    if (existing) return existing;
    const completion = this.runExecution(
      { ...run },
      documentProvider,
      inputs,
      ...args
    ).catch(
      async (e: unknown): Promise<GraphRun> => {
        const error = errorPayloadOf(e);
        try {
          await this.emitTerminal(
            { ...run },
            GraphExecutionEventType.WORKFLOW_FAILED,
            error
          );
        } catch {
          // the last-resort terminal event is best-effort
        }
        return await this.finalize({ ...run }, "failed", undefined, error, ...args);
      }
    );
    this.completions.set(run.runId, completion);
    return completion;
  }

  /** Releases all per-run state (controller, completion, timeout, publisher sequencing). */
  release(runId: string): void {
    this.auth.delete(runId);
    this.controllers.delete(runId);
    this.completions.delete(runId);
    const timeout = this.timeouts.get(runId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(runId);
    }
    this.publisher.release(runId);
  }

  private armTimeout(runId: string): void {
    const timeout = setTimeout(() => {
      this.timeouts.delete(runId);
      this.abort(runId, "timeout");
    }, this.limits.executionTimeoutMs);
    this.timeouts.set(runId, timeout);
  }

  private async runExecution(
    current: GraphRun,
    documentProvider: GraphRunDocumentProvider,
    inputs: GraphExecutionValues,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun> {
    const runId = current.runId;
    let terminalEmitted = false;
    let lastError: GraphExecutionErrorPayload | undefined;
    let result: GraphExecutionResult | undefined;

    const unsubscribe = this.engine.observe({
      refresh: async (event: GraphExecutionEvent) => {
        if (event.runId !== runId) return;
        if (event.error) lastError = event.error;
        const envelope = await this.publisher.publish(
          this.envelopeOf(current, event)
        );
        if (isGraphRunTerminalEventType(envelope.type)) {
          terminalEmitted = true;
        } else if (
          event.type === GraphExecutionEventType.WORKFLOW_STARTED &&
          current.status === "validating"
        ) {
          current.status = "running";
          await this.persist(current, ...args);
        }
      },
    });

    this.armTimeout(runId);

    try {
      if (this.isAborted(runId)) {
        const error: GraphExecutionErrorPayload = {
          name: "GraphRunCancelledError",
          message: `Graph run '${runId}' was cancelled before execution started`,
          code: "GRAPH_RUN_CANCELLED",
        };
        lastError = error;
        await this.emitTerminal(
          current,
          GraphExecutionEventType.WORKFLOW_CANCELLED,
          error
        );
        terminalEmitted = true;
        return await this.finalize(current, "cancelled", undefined, error, ...args);
      }

      current.status = "validating";
      current.startedAt = new Date().toISOString();
      await this.persist(current, ...args);

      let document: GraphWorkflowDocument;
      let fingerprint: string;
      try {
        ({ document, fingerprint } = await documentProvider(...args));
        current.documentFingerprint = fingerprint;
        await this.persist(current, ...args);
      } catch (e: unknown) {
        const error = errorPayloadOf(e);
        lastError = error;
        if (!terminalEmitted) {
          await this.emitTerminal(
            current,
            GraphExecutionEventType.WORKFLOW_FAILED,
            error
          );
          terminalEmitted = true;
        }
        return await this.finalize(
          current,
          "failed",
          undefined,
          error,
          ...args
        );
      }

      if (this.isAborted(runId)) {
        const error: GraphExecutionErrorPayload = {
          name: "GraphRunCancelledError",
          message: `Graph run '${runId}' was cancelled before execution started`,
          code: "GRAPH_RUN_CANCELLED",
        };
        lastError = error;
        if (!terminalEmitted) {
          await this.emitTerminal(
            current,
            GraphExecutionEventType.WORKFLOW_CANCELLED,
            error
          );
          terminalEmitted = true;
        }
        return await this.finalize(
          current,
          "cancelled",
          undefined,
          error,
          ...args
        );
      }

      try {
        result = await this.engine.execute(
          document,
          inputs,
          {
            runId,
            abortSignal: this.controllers.get(runId)?.signal,
            metadata: { documentFingerprint: fingerprint },
            // The caller's principal travels with the run (a worker does not
            // execute inside the creating request's context).
            ...(this.auth.get(runId) ? { auth: this.auth.get(runId) } : {}),
          },
          ...args
        );
      } catch (e: unknown) {
        lastError = errorPayloadOf(e);
      }

      const abortReason = this.abortReason(runId);
      let status: GraphRunStatus;
      let error: GraphExecutionErrorPayload | undefined;

      if (abortReason === "shutdown") {
        status = "failed";
        error = {
          name: "GraphRunInterruptedError",
          message: `Graph run '${runId}' was interrupted by a worker shutdown`,
          code: "GRAPH_RUN_INTERRUPTED",
        };
      } else if (abortReason === "timeout") {
        status = "failed";
        error =
          lastError ??
          {
            name: "GraphRunTimeoutError",
            message: `Graph run '${runId}' exceeded the configured execution timeout of ${this.limits.executionTimeoutMs}ms`,
            code: "GRAPH_RUN_TIMEOUT",
          };
      } else if (abortReason === "user") {
        status = "cancelled";
        error = lastError;
      } else if (result?.status === GraphExecutionStatus.SUSPENDED) {
        // A suspended run is paused awaiting external (HITL) input, not
        // finished: keep the non-terminal run status and emit no terminal event.
        return await this.suspend(current, ...args);
      } else if (result?.status === GraphExecutionStatus.SUCCEEDED) {
        status = "succeeded";
      } else if (result?.status === GraphExecutionStatus.CANCELLED) {
        status = "cancelled";
        error = lastError;
      } else {
        status = "failed";
        error =
          lastError ??
          errorPayloadOf(
            new GraphExecutionError(
              result
                ? `Graph run '${runId}' failed`
                : `Graph run '${runId}' failed without a result`,
              "GRAPH_RUN_FAILED",
              { runId }
            )
          );
      }

      if (!terminalEmitted) {
        await this.emitTerminal(
          current,
          status === "succeeded"
            ? GraphExecutionEventType.WORKFLOW_COMPLETED
            : status === "cancelled"
              ? GraphExecutionEventType.WORKFLOW_CANCELLED
              : GraphExecutionEventType.WORKFLOW_FAILED,
          error
        );
      }

      return await this.finalize(current, status, result, error, ...args);
    } finally {
      unsubscribe();
      const timeout = this.timeouts.get(runId);
      if (timeout) {
        clearTimeout(timeout);
        this.timeouts.delete(runId);
      }
    }
  }

  private async emitTerminal(
    run: GraphRun,
    type:
      | GraphExecutionEventType.WORKFLOW_COMPLETED
      | GraphExecutionEventType.WORKFLOW_FAILED
      | GraphExecutionEventType.WORKFLOW_CANCELLED,
    error: GraphExecutionErrorPayload | undefined
  ): Promise<void> {
    await this.publisher.publish({
      runId: run.runId,
      workflowId: run.workflowId,
      type,
      error,
    });
  }

  /**
   * Leaves a suspended run in its non-terminal `running` state. The engine
   * paused execution awaiting external (HITL) input, so the run is neither
   * finished nor failed: no terminal event is emitted and no `finishedAt` is
   * stamped, so a later resume continues the same run.
   *
   * @param {GraphRun} current - The run to leave suspended in the run store.
   * @param {...MaybeContextualArg<Context>} args - Optional Decaf context
   * arguments forwarded to the run store when persisting the run.
   * @returns {Promise<GraphRun>} The persisted run, still in its non-terminal
   * `running` state.
   */
  private async suspend(
    current: GraphRun,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun> {
    current.status = "running";
    // Waiting for external input: no worker beats for it, and orphan
    // recovery leaves it alone.
    current.suspendedAt = new Date().toISOString();
    await this.persist(current, ...args);
    return current;
  }

  private async finalize(
    current: GraphRun,
    status: GraphRunStatus,
    result: GraphExecutionResult | undefined,
    error: GraphExecutionErrorPayload | undefined,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun> {
    current.status = status;
    current.suspendedAt = undefined;
    if (result) {
      if (this.hooks.runData) {
        // The heavy part goes to the run data object, once; the row keeps
        // the summary.
        const data = graphRunResultDataOf(result);
        await timedGraphStoreOperation("run-data", "save", () =>
          this.hooks.runData!.save(current.runId, { result: data })
        );
        current.result = graphRunResultSummaryOf(result);
        current.storedBytes = storedBytesOf(data);
      } else {
        current.result = result;
      }
    }
    if (error) current.error = error;
    if (!current.startedAt) current.startedAt = new Date().toISOString();
    current.finishedAt = new Date().toISOString();
    await this.persist(current, ...args);
    graphMetrics.runsFinished.add(1, { status });
    const durationMs =
      graphRunTimeOf(current.finishedAt) - graphRunTimeOf(current.startedAt);
    if (Number.isFinite(durationMs)) {
      graphMetrics.runDuration.record(durationMs / 1000, { status });
    }
    try {
      await this.hooks.onRunCompleted?.(current, result);
    } catch {
      // result persistence failures must not mask the run's terminal state
    }
    return current;
  }

  private async persist(
    run: GraphRun,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    await this.runStore.saveRun({ ...run }, ...args);
  }

  private envelopeOf(
    run: GraphRun,
    event: GraphExecutionEvent
  ): GraphRunEventEnvelopeInput {
    return {
      runId: run.runId,
      workflowId: event.workflowId ?? run.workflowId,
      type: event.type,
      nodeId: event.nodeId,
      edgeId: event.edgeId,
      payload:
        event.payload === undefined
          ? undefined
          : isGraphJsonValue(event.payload)
            ? (event.payload as GraphJsonValue)
            : { nonSerializable: true },
      error: event.error,
      parentRunId: event.parentRunId,
      path: event.path,
    };
  }
}

function errorPayloadOf(e: unknown): GraphExecutionErrorPayload {
  if (e instanceof Error) {
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
      code:
        (e as { graphCode?: string }).graphCode ??
        (typeof (e as { code?: unknown }).code === "number"
          ? String((e as { code?: number }).code)
          : ((e as { code?: unknown }).code as string | undefined)),
    };
  }
  return { name: "UnknownError", message: String(e) };
}
