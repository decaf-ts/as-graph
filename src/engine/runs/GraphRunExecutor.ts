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
export type GraphRunAbortReason = "user" | "timeout";

/** Lifecycle hooks observed by {@link GraphRunExecutor} when a run completes. */
export interface GraphRunExecutionHooks {
  /** Called once a run reaches a terminal state, with its result when successful. */
  onRunCompleted?: (
    run: GraphRun,
    result?: GraphExecutionResult
  ) => Promise<void>;
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
    return signal.reason === "timeout" ? "timeout" : "user";
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
          },
          ...args
        );
      } catch (e: unknown) {
        lastError = errorPayloadOf(e);
      }

      const abortReason = this.abortReason(runId);
      let status: GraphRunStatus;
      let error: GraphExecutionErrorPayload | undefined;

      if (abortReason === "timeout") {
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

  private async finalize(
    current: GraphRun,
    status: GraphRunStatus,
    result: GraphExecutionResult | undefined,
    error: GraphExecutionErrorPayload | undefined,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun> {
    current.status = status;
    if (result) current.result = result;
    if (error) current.error = error;
    if (!current.startedAt) current.startedAt = new Date().toISOString();
    current.finishedAt = new Date().toISOString();
    await this.persist(current, ...args);
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
