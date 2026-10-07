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
}

/**
 * Bridges a Dagster run's raw event stream onto the engine-agnostic event sink.
 */
export class DagsterGraphEventBridge {
  private readonly nodeResults = new Map<string, GraphNodeExecutionResult>();
  private readonly workflowOutputs: Record<string, unknown> = {};
  private subscription?: DagsterRunSubscription;
  private terminal?: DagsterRunRecord;
  private resolveTerminal?: (record: DagsterRunRecord) => void;
  private rejectTerminal?: (error: unknown) => void;
  private readonly processing: Promise<void>[] = [];
  private readonly terminalPromise: Promise<DagsterRunRecord>;

  /**
   * @param options - The run identity, op-name map, sink, and client port.
   */
  constructor(private readonly options: DagsterGraphEventBridgeOptions) {
    this.terminalPromise = new Promise<DagsterRunRecord>((resolve, reject) => {
      this.resolveTerminal = resolve;
      this.rejectTerminal = reject;
    });
  }

  /** Subscribes to the run's event stream. */
  async start(): Promise<void> {
    this.subscription = await this.options.client.subscribeRun(
      this.options.dagsterRunId,
      (event) => {
        this.processing.push(this.handleEvent(event));
      }
    );
  }

  /** Stops the subscription and waits for in-flight event processing. */
  async stop(): Promise<void> {
    await this.subscription?.unsubscribe();
    await Promise.all(this.processing);
  }

  /**
   * Waits for the run's terminal record.
   *
   * @returns The terminal Dagster run record.
   */
  async waitForTerminal(): Promise<DagsterRunRecord> {
    if (this.terminal) return this.terminal;
    return await this.terminalPromise;
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
