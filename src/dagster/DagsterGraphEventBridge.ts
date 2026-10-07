/**
 * @module as-graph/dagster/DagsterGraphEventBridge
 * @summary Maps raw Dagster events onto the engine-agnostic event sink (SAA-195 §4.3).
 * @description Subscribes to a Dagster run's raw event stream and translates every
 * step/run event into the shared {@link GraphExecutionEventType} vocabulary before
 * forwarding it through the facade-owned {@link GraphExecutionEventSink}. Only the
 * documented mapping table is accepted: a step-level event type with no mapping
 * fails loudly (`GRAPH_DAGSTER_EVENT_UNSUPPORTED`), while unknown run/engine-level
 * events are ignored so Dagster's internal telemetry cannot break the run.
 */
import type { GraphExecutionEvent } from "../shared/graph";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../shared/graph";
import type { GraphExecutionErrorPayload } from "../shared/graph";
import type { GraphNodeExecutionResult } from "../engine/types";
import type { GraphExecutionEventSink } from "../engine/execution/GraphExecutionBackend";
import { GraphExecutionError } from "../engine/errors";
import { DAGSTER_ERROR } from "./constants";
import type {
  DagsterClient,
  DagsterEventRecord,
  DagsterRunRecord,
  DagsterRunSubscription,
} from "./DagsterTypes";

/**
 * The documented Dagster → engine-agnostic event mapping table (§4.3).
 */
const DAGSTER_EVENT_MAP: Record<string, GraphExecutionEventType> = {
  STEP_START: GraphExecutionEventType.NODE_STARTED,
  STEP_SUCCESS: GraphExecutionEventType.NODE_COMPLETED,
  STEP_FAILURE: GraphExecutionEventType.NODE_FAILED,
  STEP_SKIPPED: GraphExecutionEventType.NODE_SKIPPED,
  STEP_OUTPUT: GraphExecutionEventType.NODE_OUTPUT,
  RUN_START: GraphExecutionEventType.WORKFLOW_STARTED,
  RUN_SUCCESS: GraphExecutionEventType.WORKFLOW_COMPLETED,
  RUN_FAILURE: GraphExecutionEventType.WORKFLOW_FAILED,
  RUN_CANCELED: GraphExecutionEventType.WORKFLOW_CANCELLED,
};

/** Dagster event types that terminate a run. */
const DAGSTER_TERMINAL_EVENTS = new Set<string>([
  "RUN_SUCCESS",
  "RUN_FAILURE",
  "RUN_CANCELED",
]);

/**
 * Default hard cap on the number of events the bridge processes before failing
 * the observation closed. Bounds a gateway that never emits a terminal event.
 */
const DEFAULT_MAX_EVENTS = 10000;

/**
 * Default hard cap on the transport pagination depth. Bounds a gateway whose
 * `eventConnection` never reports `hasMore: false`.
 */
const DEFAULT_MAX_PAGES = 100;

/**
 * Default maximum time (ms) to await the terminal record before failing the
 * observation closed. Callers observing a genuinely long-lived run raise this.
 */
const DEFAULT_TERMINAL_TIMEOUT_MS = 5 * 60 * 1000;

/** Options for constructing a {@link DagsterGraphEventBridge}. */
export interface DagsterGraphEventBridgeOptions {
  /** The Dagster run id to subscribe to. */
  dagsterRunId: string;
  /** The canonical as-graph run id carried on emitted events. */
  graphRunId: string;
  /** Canonical workflow id. */
  workflowId: string;
  /**
   * The inspected job's op-name → canonical node-id map. Built from the
   * deployment structure the read-only driver looked up; the bridge never
   * translates a document.
   */
  nodeIdsByOpName: Record<string, string>;
  /** The facade-owned event sink. */
  sink: GraphExecutionEventSink;
  /** The host-injected client port. */
  client: DagsterClient;
  /** Cancels the observation and any in-flight transport work. */
  signal?: AbortSignal;
  /** Hard cap on processed events; defaults to {@link DEFAULT_MAX_EVENTS}. */
  maxEvents?: number;
  /** Hard cap on transport pagination pages; defaults to {@link DEFAULT_MAX_PAGES}. */
  maxPages?: number;
  /**
   * Maximum time to await the terminal record; defaults to
   * {@link DEFAULT_TERMINAL_TIMEOUT_MS}.
   */
  terminalTimeoutMs?: number;
}

/**
 * Bridges a Dagster run's raw event stream onto the engine-agnostic event sink.
 */
export class DagsterGraphEventBridge {
  private readonly nodeResults = new Map<string, GraphNodeExecutionResult>();
  private readonly workflowOutputs: Record<string, unknown> = {};
  private subscription?: DagsterRunSubscription;
  private terminal?: DagsterRunRecord;
  private failure?: GraphExecutionError;
  private eventCount = 0;
  private resolveTerminal?: (record: DagsterRunRecord) => void;
  private rejectTerminal?: (error: unknown) => void;
  private readonly processing: Promise<void>[] = [];
  private readonly terminalPromise: Promise<DagsterRunRecord>;

  /**
   * @param options - The run identity, op-name map, sink, client port, and bounds.
   */
  constructor(private readonly options: DagsterGraphEventBridgeOptions) {
    this.terminalPromise = new Promise<DagsterRunRecord>((resolve, reject) => {
      this.resolveTerminal = resolve;
      this.rejectTerminal = reject;
    });
    // A scripted client can overflow the event cap during the synchronous replay
    // inside `subscribeRun`, before `waitForTerminal` attaches its handler. Keep a
    // no-op rejection handler so that early failure is never "unhandled".
    this.terminalPromise.catch(() => {});
  }

  /** Subscribes to the run's event stream. */
  async start(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.options.signal?.aborted) {
      throw this.failClosed(this.abortError());
    }
    this.subscription = await this.options.client.subscribeRun(
      this.options.dagsterRunId,
      (event) => {
        this.processing.push(this.handleEvent(event));
      },
      {
        ...(this.options.signal ? { signal: this.options.signal } : {}),
        maxEvents: this.options.maxEvents ?? DEFAULT_MAX_EVENTS,
        maxPages: this.options.maxPages ?? DEFAULT_MAX_PAGES,
      }
    );
  }

  /** Stops the subscription and waits for in-flight event processing. */
  async stop(): Promise<void> {
    await this.subscription?.unsubscribe();
    await Promise.all(this.processing);
    if (this.failure) throw this.failure;
  }

  /**
   * Waits for the run's terminal record, bounded by the observation's
   * `terminalTimeoutMs` and `signal`. Exceeding the timeout, or an abort, fails
   * the wait closed instead of hanging on a stalled or hostile gateway.
   *
   * @returns The terminal Dagster run record.
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_OBSERVE_TIMEOUT` when the run
   *   does not terminate in time, or `GRAPH_DAGSTER_OBSERVE_ABORTED` on abort.
   */
  async waitForTerminal(): Promise<DagsterRunRecord> {
    if (this.terminal) return this.terminal;
    if (this.failure) throw this.failure;
    const signal = this.options.signal;
    if (signal?.aborted) {
      throw this.failClosed(this.abortError());
    }
    const timeoutMs =
      this.options.terminalTimeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS;
    return await new Promise<DagsterRunRecord>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        cleanup();
        this.failClosed(this.abortError());
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.failClosed(this.timeoutError(timeoutMs));
        }, timeoutMs);
      }
      this.terminalPromise.then(
        (record) => {
          cleanup();
          resolve(record);
        },
        (error) => {
          cleanup();
          reject(error);
        }
      );
    });
  }

  /** The node results collected from step events. */
  collectedNodeResults(): Record<string, GraphNodeExecutionResult> {
    return Object.fromEntries(this.nodeResults);
  }

  /** The workflow output values collected from the terminal record. */
  collectedWorkflowOutputs(): Record<string, unknown> {
    return this.workflowOutputs;
  }

  /**
   * Resolves a Dagster step key to a canonical node id through the inspected
   * job's op-name map.
   *
   * @param stepKey - The Dagster step key.
   * @returns The canonical node id, or `undefined` for non-graph steps.
   */
  private resolveNodeId(stepKey: string | undefined): string | undefined {
    if (!stepKey) return undefined;
    const direct = this.options.nodeIdsByOpName[stepKey];
    if (direct) return direct;
    const tail = stepKey.split(".").pop();
    return tail ? this.options.nodeIdsByOpName[tail] : undefined;
  }

  /**
   * Handles a single raw Dagster event.
   *
   * @param event - The raw event.
   */
  private async handleEvent(event: DagsterEventRecord): Promise<void> {
    if (this.failure) return;
    this.eventCount += 1;
    const maxEvents = this.options.maxEvents ?? DEFAULT_MAX_EVENTS;
    if (this.eventCount > maxEvents) {
      this.failClosed(this.limitError(maxEvents));
      return;
    }
    const type = DAGSTER_EVENT_MAP[event.type];
    if (!type) {
      if (event.stepKey !== undefined || event.type.startsWith("STEP_")) {
        throw new GraphExecutionError(
          `Dagster step event '${event.type}' has no engine-agnostic mapping`,
          DAGSTER_ERROR.EVENT_UNSUPPORTED,
          { eventType: event.type, stepKey: event.stepKey }
        );
      }
      // Unknown run/engine-level telemetry is ignored: it is not a graph
      // transition and must not break the run.
      return;
    }

    if (DAGSTER_TERMINAL_EVENTS.has(event.type)) {
      const record = await this.options.client.getRun(this.options.dagsterRunId);
      this.terminal = record;
      if (record.outputs) {
        for (const [key, value] of Object.entries(record.outputs)) {
          this.workflowOutputs[key] = value;
        }
      }
      await this.options.sink.emit({
        type,
        runId: this.options.graphRunId,
        workflowId: this.options.workflowId,
        path: [],
        status: this.terminalStatus(record),
        ...(record.error
          ? { error: this.toErrorPayload(record.error) }
          : {}),
        payload: { outputs: this.workflowOutputs },
      });
      this.resolveTerminal?.(record);
      return;
    }

    const nodeId = this.resolveNodeId(event.stepKey);
    if (!nodeId) {
      // Run-level, non-terminal transitions (e.g. `RUN_START`) carry no step
      // key and map onto the workflow without a node id. A step event whose key
      // the inspected job does not know is still ignored.
      if (event.stepKey !== undefined) return;
      await this.options.sink.emit({
        type,
        runId: this.options.graphRunId,
        workflowId: this.options.workflowId,
        path: [],
      });
      return;
    }

    const status = this.nodeStatus(event.type);
    const outputs = this.extractOutputs(event);
    if (outputs) {
      this.workflowOutputs[nodeId] = outputs;
    }
    this.nodeResults.set(nodeId, {
      nodeId,
      status,
      inputs: {},
      ...(outputs ? { outputs } : {}),
      startedAt: new Date(),
      finishedAt: new Date(),
      events: [],
      ...(status === GraphExecutionStatus.FAILED && event.message
        ? { error: this.toErrorPayload({ message: event.message }) }
        : {}),
    });

    await this.options.sink.emit({
      type,
      runId: this.options.graphRunId,
      workflowId: this.options.workflowId,
      nodeId,
      path: [nodeId],
      status,
      ...(outputs ? { payload: { outputs } } : {}),
      ...(status === GraphExecutionStatus.FAILED && event.message
        ? { error: this.toErrorPayload({ message: event.message }) }
        : {}),
    });
  }

  /**
   * Maps a Dagster event type to an engine-agnostic execution status.
   *
   * @param eventType - The Dagster event type.
   * @returns The engine-agnostic status.
   */
  private nodeStatus(eventType: string): GraphExecutionStatus {
    switch (eventType) {
      case "STEP_SUCCESS":
        return GraphExecutionStatus.SUCCEEDED;
      case "STEP_FAILURE":
        return GraphExecutionStatus.FAILED;
      case "STEP_SKIPPED":
        return GraphExecutionStatus.SKIPPED;
      default:
        return GraphExecutionStatus.RUNNING;
    }
  }

  /**
   * Maps a terminal Dagster run record to an engine-agnostic status.
   *
   * @param record - The terminal run record.
   * @returns The engine-agnostic status.
   */
  private terminalStatus(record: DagsterRunRecord): GraphExecutionStatus {
    switch (record.status) {
      case "success":
        return GraphExecutionStatus.SUCCEEDED;
      case "canceled":
        return GraphExecutionStatus.CANCELLED;
      default:
        return GraphExecutionStatus.FAILED;
    }
  }

  /**
   * Extracts output values from a Dagster step event payload.
   *
   * @param event - The raw event.
   * @returns The extracted outputs, or `undefined`.
   */
  private extractOutputs(
    event: DagsterEventRecord
  ): Record<string, unknown> | undefined {
    if (event.type !== "STEP_OUTPUT") return undefined;
    const payload = event.payload ?? {};
    const raw = payload["outputs"];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return payload;
  }

  /**
   * Fails the observation closed exactly once: records the failure, rejects the
   * terminal wait, and cancels the underlying subscription so a stalled transport
   * stops working.
   *
   * @param error - The graph error the observation failed with.
   * @returns The same error, for convenient `throw`/`return` use.
   */
  private failClosed(error: GraphExecutionError): GraphExecutionError {
    if (!this.failure) {
      this.failure = error;
      this.rejectTerminal?.(error);
      const subscription = this.subscription;
      if (subscription) {
        void Promise.resolve(subscription.unsubscribe()).catch(() => {});
      }
    }
    return this.failure;
  }

  /** The error raised when the caller aborts the observation. */
  private abortError(): GraphExecutionError {
    return new GraphExecutionError(
      `Dagster run '${this.options.dagsterRunId}' observation was aborted by the caller`,
      DAGSTER_ERROR.OBSERVE_ABORTED,
      { runId: this.options.dagsterRunId }
    );
  }

  /** The error raised when the run misses the terminal-wait timeout. */
  private timeoutError(timeoutMs: number): GraphExecutionError {
    return new GraphExecutionError(
      `Dagster run '${this.options.dagsterRunId}' did not reach a terminal state within ${timeoutMs}ms`,
      DAGSTER_ERROR.OBSERVE_TIMEOUT,
      { runId: this.options.dagsterRunId, timeoutMs }
    );
  }

  /** The error raised when the run exceeds the event cap. */
  private limitError(maxEvents: number): GraphExecutionError {
    return new GraphExecutionError(
      `Dagster run '${this.options.dagsterRunId}' emitted more than ${maxEvents} events without reaching a terminal state`,
      DAGSTER_ERROR.EVENT_LIMIT_EXCEEDED,
      { runId: this.options.dagsterRunId, maxEvents }
    );
  }

  /**
   * Builds a frontend-safe error payload. Raw Dagster details are never
   * forwarded to clients (standing hardening rule).
   *
   * @param error - The raw error.
   * @returns The frontend-safe error payload.
   */
  private toErrorPayload(error: {
    message?: string;
    code?: string;
  }): GraphExecutionErrorPayload {
    return {
      name: "DagsterRunError",
      message: error.message ?? "Dagster run failed",
      ...(error.code ? { code: error.code } : {}),
    };
  }
}

/** Re-exported for typing clarity. */
export type { GraphExecutionEvent };
