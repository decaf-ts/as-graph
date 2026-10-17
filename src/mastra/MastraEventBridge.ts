/**
 * @module as-graph/mastra/MastraEventBridge
 * @summary Bridges Mastra's `fullStream` events onto the facade event sink
 * (SAA-196).
 * @description The bridge consumes the async event stream a Mastra run emits,
 * translates workflow/step/log lifecycle events into canonical
 * {@link GraphExecutionEvent} emissions, and mirrors node/edge visual-state and
 * routed edge values so the canvas renders a Mastra run exactly like a local
 * one. Unrecognised events are ignored unless they look like log entries.
 */
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import type { GraphEdgeInstance } from "../shared/graph/document/GraphEdgeInstance";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
  GraphVisualState,
} from "../shared/graph/constants";
import type { GraphExecutionEventSink } from "../engine/execution/GraphExecutionBackend";
import type { GraphRunLogEntry } from "../shared/graph/types";

/** Options a {@link MastraEventBridge} is created with. */
export interface MastraEventBridgeOptions {
  /** The canonical run id the bridged events belong to. */
  runId: string;
  /** The parent run id, when the run is a nested execution. */
  parentRunId?: string;
  /** The canonical workflow id the bridged events belong to. */
  workflowId: string;
  /** The canonical document the Mastra workflow was compiled from. */
  document: GraphWorkflowDocument;
  /** The frame-aware facade event sink every event is emitted onto. */
  sink: GraphExecutionEventSink;
  /** The node path prefix events are reported under. */
  path?: string[];
}

/** One raw Mastra `fullStream` event; shape is runtime-defined. */
export type MastraFullStreamEvent = Record<string, unknown>;

/** Log levels accepted in bridged log events; anything else is dropped. */
const LOG_LEVELS = new Set([
  "silly",
  "trace",
  "debug",
  "verbose",
  "info",
  "warn",
  "error",
  "critical",
  "fatal",
  "benchmark",
]);

/**
 * Resolves the node-scoped endpoint id of an edge side.
 *
 * @param edge - The edge to inspect.
 * @param side - Which side of the edge to read.
 * @returns The node id when the endpoint is node-scoped, else `undefined`.
 */
function nodeEndpointId(
  edge: GraphEdgeInstance,
  side: "source" | "target"
): string | undefined {
  const endpoint = edge[side];
  return endpoint.scope === "node" ? endpoint.nodeId : undefined;
}

/**
 * Resolves the port name of an edge side.
 *
 * @param edge - The edge to inspect.
 * @param side - Which side of the edge to read.
 * @returns The endpoint port name.
 */
function endpointPort(
  edge: GraphEdgeInstance,
  side: "source" | "target"
): string {
  return edge[side].port;
}

/**
 * Translates Mastra `fullStream` events into canonical facade events. The
 * bridge indexes the document's data edges by node endpoint so step results can
 * be routed as edge values and step lifecycles can drive node/edge visual
 * states. Log events (`log`, `writer`, `console`) are surfaced as
 * `GRAPH_RUN_LOG` entries with a known log level.
 */
export class MastraEventBridge {
  /** Data edges leaving each node, keyed by source node id. */
  private readonly outgoing = new Map<string, GraphEdgeInstance[]>();
  /** Data edges entering each node, keyed by target node id. */
  private readonly incoming = new Map<string, GraphEdgeInstance[]>();
  /**
   * The run's terminal execution status, recorded from the `workflow-finish`
   * event (or `workflow-canceled`). Kept in lock-step with the terminal workflow
   * event this bridge emits, so a caller can never return a status that
   * contradicts the event stream it produced.
   */
  private terminalWorkflowStatus?: GraphExecutionStatus;

  /**
   * Creates the bridge and indexes the document's node-scoped data edges.
   *
   * @param options - Run identity, document, and event sink options.
   */
  constructor(private readonly options: MastraEventBridgeOptions) {
    for (const edge of options.document.edges ?? []) {
      if (edge.type !== "data") continue;
      const source = nodeEndpointId(edge, "source");
      const target = nodeEndpointId(edge, "target");
      if (source) {
        const list = this.outgoing.get(source) ?? [];
        list.push(edge);
        this.outgoing.set(source, list);
      }
      if (target) {
        const list = this.incoming.get(target) ?? [];
        list.push(edge);
        this.incoming.set(target, list);
      }
    }
  }

  /**
   * The run's terminal execution status once the bridge has consumed the
   * run's `workflow-finish`/`workflow-canceled` event.
   *
   * @return {GraphExecutionStatus | undefined} The terminal status, or
   * `undefined` before a terminal event was consumed or when that event carries
   * no terminal outcome (e.g. a suspended run).
   */
  get terminalStatus(): GraphExecutionStatus | undefined {
    return this.terminalWorkflowStatus;
  }

  /**
   * Consumes a Mastra run's full event stream until it ends.
   *
   * @param stream - The async iterable of Mastra `fullStream` events.
   * @returns Resolves when the stream is exhausted.
   */
  async attach(stream: AsyncIterable<MastraFullStreamEvent>): Promise<void> {
    for await (const event of stream) {
      await this.handle(event);
    }
  }

  /**
   * Translates one raw Mastra event and emits the matching canonical events.
   * Unrecognised event types are ignored unless they look like log entries.
   *
   * @param event - The raw Mastra `fullStream` event.
   * @returns Resolves once the derived events have been emitted.
   */
  async handle(event: MastraFullStreamEvent): Promise<void> {
    const type = typeof event["type"] === "string" ? event["type"] : undefined;
    switch (type) {
      case "workflow-start":
        await this.emit({
          type: GraphExecutionEventType.WORKFLOW_STARTED,
          status: GraphExecutionStatus.RUNNING,
        });
        return;
      case "workflow-step-start":
        await this.onStepStart(event);
        return;
      case "workflow-step-output":
        await this.onStepOutput(event);
        return;
      case "workflow-step-progress":
        await this.onStepProgress(event);
        return;
      case "workflow-step-result":
        await this.onStepResult(event);
        return;
      case "workflow-step-suspended":
        await this.onStepSuspended(event);
        return;
      case "workflow-finish":
        await this.onWorkflowFinish(event);
        return;
      case "workflow-canceled":
        this.terminalWorkflowStatus = GraphExecutionStatus.CANCELLED;
        await this.emit({
          type: GraphExecutionEventType.WORKFLOW_CANCELLED,
          status: GraphExecutionStatus.CANCELLED,
        });
        return;
      case "log":
      case "writer":
      case "console":
        await this.onLog(event);
        return;
      default:
        if (this.looksLikeLog(event)) {
          await this.onLog(event);
        }
    }
  }

  /**
   * Emits the node-started lifecycle, node visual state, and running edge
   * states for the incoming data edges of a started step.
   *
   * @param event - The raw `workflow-step-start` event.
   * @returns Resolves once the derived events have been emitted.
   */
  private async onStepStart(event: MastraFullStreamEvent): Promise<void> {
    const nodeId = this.stepId(event);
    if (!nodeId) return;
    const path = [...(this.options.path ?? []), nodeId];
    await this.emit({
      type: GraphExecutionEventType.NODE_STARTED,
      nodeId,
      path,
      status: GraphExecutionStatus.RUNNING,
    });
    await this.emitNodeState(nodeId, GraphVisualState.RUNNING, path);
    for (const edge of this.incoming.get(nodeId) ?? []) {
      await this.emitEdgeState(edge, GraphVisualState.RUNNING, GraphExecutionStatus.RUNNING);
    }
  }

  /**
   * Emits the step's incremental output as a node-output event.
   *
   * @param event - The raw `workflow-step-output` event.
   * @returns Resolves once the derived events have been emitted.
   */
  private async onStepOutput(event: MastraFullStreamEvent): Promise<void> {
    const nodeId = this.stepId(event);
    if (!nodeId) return;
    const payload = this.payloadOf(event);
    await this.emit({
      type: GraphExecutionEventType.NODE_OUTPUT,
      nodeId,
      path: [...(this.options.path ?? []), nodeId],
      status: GraphExecutionStatus.RUNNING,
      payload: { outputs: payload["output"] ?? payload },
    });
  }

  /**
   * Emits one loop-iteration progress event for a foreach/while step.
   *
   * @param event - The raw `workflow-step-progress` event.
   * @returns Resolves once the derived events have been emitted.
   */
  private async onStepProgress(event: MastraFullStreamEvent): Promise<void> {
    const nodeId = this.stepId(event);
    if (!nodeId) return;
    const payload = this.payloadOf(event);
    const iteration = typeof payload["currentIndex"] === "number" ? payload["currentIndex"] : undefined;
    const failed = payload["iterationStatus"] === "failed";
    await this.emit({
      type: GraphExecutionEventType.LOOP_ITERATION_COMPLETED,
      nodeId,
      path: [...(this.options.path ?? []), nodeId],
      status: failed ? GraphExecutionStatus.FAILED : GraphExecutionStatus.SUCCEEDED,
      iteration,
      payload: {
        completedCount: payload["completedCount"],
        totalCount: payload["totalCount"],
        iterationStatus: payload["iterationStatus"],
      },
    });
  }

  /**
   * Emits the terminal lifecycle of a finished step: failure, suspension
   * block, or completion (including routed outgoing edge values).
   *
   * @param event - The raw `workflow-step-result` event.
   * @returns Resolves once the derived events have been emitted.
   */
  private async onStepResult(event: MastraFullStreamEvent): Promise<void> {
    const nodeId = this.stepId(event);
    if (!nodeId) return;
    const payload = this.payloadOf(event);
    const status = payload["status"];
    const path = [...(this.options.path ?? []), nodeId];
    const output = payload["output"];
    if (status === "failed") {
      await this.emit({
        type: GraphExecutionEventType.NODE_FAILED,
        nodeId,
        path,
        status: GraphExecutionStatus.FAILED,
        error: this.errorPayload(payload["error"] ?? payload),
      });
      await this.emitNodeState(nodeId, GraphVisualState.FAILED, path);
      return;
    }
    if (status === "suspended") {
      await this.emitNodeState(nodeId, GraphVisualState.BLOCKED, path);
      return;
    }
    await this.emit({
      type: GraphExecutionEventType.NODE_COMPLETED,
      nodeId,
      path,
      status: GraphExecutionStatus.SUCCEEDED,
      payload: { outputs: output ?? {} },
    });
    await this.emitNodeState(nodeId, GraphVisualState.SUCCEEDED, path);
    await this.routeEdges(nodeId, output, path);
  }

  /**
   * Emits the suspension state of a suspended step and the workflow-suspended
   * event carrying Mastra's suspend payload.
   *
   * @param event - The raw `workflow-step-suspended` event.
   * @returns Resolves once the derived events have been emitted.
   */
  private async onStepSuspended(event: MastraFullStreamEvent): Promise<void> {
    const nodeId = this.stepId(event);
    if (!nodeId) return;
    const path = [...(this.options.path ?? []), nodeId];
    await this.emitNodeState(nodeId, GraphVisualState.BLOCKED, path);
    await this.emit({
      type: GraphExecutionEventType.WORKFLOW_SUSPENDED,
      nodeId,
      path,
      status: GraphExecutionStatus.PENDING,
      payload: { suspend: this.payloadOf(event)["suspendPayload"] },
    });
  }

  /**
   * Emits the terminal workflow event: failed, cancelled, or completed with
   * the final workflow result.
   *
   * @param event - The raw `workflow-finish` event.
   * @returns Resolves once the derived events have been emitted.
   */
  private async onWorkflowFinish(event: MastraFullStreamEvent): Promise<void> {
    const payload = this.payloadOf(event);
    const workflowStatus = payload["workflowStatus"];
    // `tripwire` is a guardrail failure: Mastra reports the tripped step as a
    // failed `workflow-step-result` and finishes the run with `workflowStatus:
    // "tripwire"`. Surface it as a failed terminal status/event, not a completion.
    if (workflowStatus === "failed" || workflowStatus === "tripwire") {
      this.terminalWorkflowStatus = GraphExecutionStatus.FAILED;
      await this.emit({
        type: GraphExecutionEventType.WORKFLOW_FAILED,
        status: GraphExecutionStatus.FAILED,
        error: this.errorPayload(payload["error"] ?? payload),
      });
      return;
    }
    if (workflowStatus === "canceled" || workflowStatus === "cancelled") {
      this.terminalWorkflowStatus = GraphExecutionStatus.CANCELLED;
      await this.emit({
        type: GraphExecutionEventType.WORKFLOW_CANCELLED,
        status: GraphExecutionStatus.CANCELLED,
      });
      return;
    }
    if (workflowStatus === "success" || workflowStatus === "succeeded") {
      this.terminalWorkflowStatus = GraphExecutionStatus.SUCCEEDED;
    }
    await this.emit({
      type: GraphExecutionEventType.WORKFLOW_COMPLETED,
      status: GraphExecutionStatus.SUCCEEDED,
      payload: { outputs: payload["finalWorkflowResult"] ?? payload["output"] },
    });
  }

  /**
   * Emits a run-log entry for a bridged log event; unknown levels are dropped.
   *
   * @param event - The raw log/writer/console event.
   * @returns Resolves once the log entry has been emitted.
   */
  private async onLog(event: MastraFullStreamEvent): Promise<void> {
    const payload = this.payloadOf(event);
    const level = typeof payload["level"] === "string" ? payload["level"] : "info";
    if (!LOG_LEVELS.has(level)) return;
    const nodeId =
      typeof payload["nodeId"] === "string" ? payload["nodeId"] : undefined;
    const entry: GraphRunLogEntry = {
      level: level as GraphRunLogEntry["level"],
      message:
        typeof payload["message"] === "string"
          ? payload["message"]
          : String(payload["message"] ?? ""),
      timestamp: new Date().toISOString(),
      runId: this.options.runId,
      workflowId: this.options.workflowId,
      ...(nodeId ? { nodeId } : {}),
    };
    await this.emit({
      type: GraphExecutionEventType.GRAPH_RUN_LOG,
      nodeId,
      status: GraphExecutionStatus.RUNNING,
      payload: entry,
    });
  }

  /**
   * Heuristic check whether an unrecognised event is a log entry.
   *
   * @param event - The raw Mastra event.
   * @returns `true` when the event carries a level and a message.
   */
  private looksLikeLog(event: MastraFullStreamEvent): boolean {
    const payload = this.payloadOf(event);
    return (
      typeof payload["level"] === "string" &&
      (typeof payload["message"] === "string" ||
        typeof event["message"] === "string")
    );
  }

  /**
   * Routes one finished node's output values along its outgoing data edges,
   * emitting edge-value and edge-state events per routed edge.
   *
   * @param nodeId - The finished node id.
   * @param output - The node's output record.
   * @param path - The node path the events are reported under.
   * @returns Resolves once the routed edge events have been emitted.
   */
  private async routeEdges(
    nodeId: string,
    output: unknown,
    path: string[]
  ): Promise<void> {
    if (!output || typeof output !== "object" || Array.isArray(output)) {
      return;
    }
    const outputs = output as Record<string, unknown>;
    for (const edge of this.outgoing.get(nodeId) ?? []) {
      const sourcePort = endpointPort(edge, "source");
      if (!Object.prototype.hasOwnProperty.call(outputs, sourcePort)) continue;
      await this.emit({
        type: GraphExecutionEventType.EDGE_VALUE_ROUTED,
        edgeId: edge.id,
        nodeId,
        path,
        status: GraphExecutionStatus.SUCCEEDED,
        payload: { edge, value: outputs[sourcePort] },
      });
      await this.emitEdgeState(
        edge,
        GraphVisualState.SUCCEEDED,
        GraphExecutionStatus.SUCCEEDED
      );
    }
  }

  /**
   * Emits a node visual-state change for the bridged run.
   *
   * @param nodeId - The node whose state changed.
   * @param state - The new visual state.
   * @param path - The node path the event is reported under.
   * @returns Resolves once the event has been emitted.
   */
  private async emitNodeState(
    nodeId: string,
    state: GraphVisualState,
    path: string[]
  ): Promise<void> {
    await this.emit({
      type: GraphExecutionEventType.NODE_STATE_CHANGED,
      nodeId,
      path,
      status: this.statusFor(state),
      payload: {
        nodeId,
        state,
        runId: this.options.runId,
        workflowId: this.options.workflowId,
      },
    });
  }

  /**
   * Emits an edge visual-state change for the bridged run.
   *
   * @param edge - The edge whose state changed.
   * @param state - The new visual state.
   * @param status - The execution status carried by the event.
   * @returns Resolves once the event has been emitted.
   */
  private async emitEdgeState(
    edge: GraphEdgeInstance,
    state: GraphVisualState,
    status: GraphExecutionStatus
  ): Promise<void> {
    await this.emit({
      type: GraphExecutionEventType.EDGE_STATE_CHANGED,
      edgeId: edge.id,
      nodeId: nodeEndpointId(edge, "source"),
      path: [],
      status,
      payload: {
        edgeId: edge.id,
        state,
        runId: this.options.runId,
        workflowId: this.options.workflowId,
        status,
      },
    });
  }

  /**
   * Maps a visual state to the execution status its event carries.
   *
   * @param state - The node visual state.
   * @returns The matching execution status.
   */
  private statusFor(state: GraphVisualState): GraphExecutionStatus {
    switch (state) {
      case GraphVisualState.SUCCEEDED:
        return GraphExecutionStatus.SUCCEEDED;
      case GraphVisualState.FAILED:
        return GraphExecutionStatus.FAILED;
      case GraphVisualState.SKIPPED:
        return GraphExecutionStatus.SKIPPED;
      default:
        return GraphExecutionStatus.RUNNING;
    }
  }

  /**
   * Resolves the Mastra step id of an event (the canonical node id).
   *
   * @param event - The raw Mastra event.
   * @returns The step id, or `undefined` when the event has none.
   */
  private stepId(event: MastraFullStreamEvent): string | undefined {
    const payload = this.payloadOf(event);
    const id = payload["id"] ?? event["id"];
    return typeof id === "string" ? id : undefined;
  }

  /**
   * Extracts an event's payload record, tolerating missing or non-object
   * payloads.
   *
   * @param event - The raw Mastra event.
   * @returns The payload record, or an empty record.
   */
  private payloadOf(event: MastraFullStreamEvent): Record<string, unknown> {
    const payload = event["payload"];
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  }

  /**
   * Normalises an arbitrary error into the canonical error payload shape.
   *
   * @param error - The thrown error or value.
   * @returns The normalised name/message/code payload.
   */
  private errorPayload(error: unknown): { name: string; message: string; code?: string } {
    if (error instanceof Error) {
      const graphCode = (error as unknown as { graphCode?: unknown }).graphCode;
      const code = (error as unknown as { code?: unknown }).code;
      const normalised =
        typeof graphCode === "string"
          ? graphCode
          : typeof code === "number"
            ? String(code)
            : typeof code === "string"
              ? code
              : undefined;
      return {
        name: error.name,
        message: error.message,
        ...(normalised !== undefined ? { code: normalised } : {}),
      };
    }
    return { name: "MastraError", message: String(error) };
  }

  /**
   * Forwards one canonical event onto the configured facade event sink.
   *
   * @param partial - The event to emit (run identity fields are supplied by
   *   the sink's frame awareness).
   * @returns Resolves once the sink accepted the event.
   */
  private async emit(
    partial: Parameters<GraphExecutionEventSink["emit"]>[0]
  ): Promise<void> {
    await this.options.sink.emit(partial);
  }
}
