/**
 * @module as-graph/shared/ui/GraphRunView
 * @summary Projects engine run results into frontend-safe run view models.
 * @description Consumes the structural shape of a `GraphExecutionResult`
 * (without importing the engine) and derives the per-node visual state from the
 * shared `GraphExecutionStateMapper` — the canonical run-state feedback a graph
 * UI renders. Per-node intermediate `inputs`/`outputs` are carried verbatim so
 * the UI can display what each node consumed and produced.
 */
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
  GraphVisualState,
  mapExecutionStatus,
  visualStateOfEvent,
} from "../graph";
import type { GraphExecutionEvent } from "../graph";
import type { GraphNodeRunView, GraphWorkflowRunView } from "./types";

/**
 * Structural node result accepted by the run view builder. Mirrors
 * `GraphNodeExecutionResult` without importing the engine.
 */
export interface GraphRunNodeResultLike {
  /** Node identifier. */
  nodeId: string;
  /** Engine execution status. */
  status?: GraphExecutionStatus | string;
  /** Intermediate inputs the node consumed. */
  inputs?: Record<string, unknown>;
  /** Intermediate outputs the node produced. */
  outputs?: Record<string, unknown>;
  /** Structured failure payload, when the node failed. */
  error?: { code?: string; message: string };
  /** Start timestamp. */
  startedAt?: Date | string;
  /** Finish timestamp. */
  finishedAt?: Date | string;
  /** Whether the result came from the engine cache. */
  fromCache?: boolean;
  /** Whether the node ran against pinned values. */
  pinned?: boolean;
  /** Engine events emitted while the node ran. */
  events?: GraphExecutionEvent[];
}

/**
 * Structural workflow result accepted by the run view builder. Mirrors
 * `GraphExecutionResult` without importing the engine.
 */
export interface GraphRunResultLike {
  /** Run identifier. */
  runId: string;
  /** Workflow identifier. */
  workflowId: string;
  /** Terminal/current engine status. */
  status: GraphExecutionStatus | string;
  /** Workflow output values. */
  outputs?: Record<string, unknown>;
  /** Per-node results, keyed by node id. */
  nodeResults?: Record<string, GraphRunNodeResultLike>;
  /** Ordered engine events for the run. */
  events?: GraphExecutionEvent[];
  /** Run start timestamp. */
  startedAt?: Date | string;
  /** Run finish timestamp. */
  finishedAt?: Date | string;
}

/** Event types that carry a node visual-state transition. */
const NODE_STATE_EVENT_TYPES: GraphExecutionEventType[] = [
  GraphExecutionEventType.NODE_STATE_CHANGED,
  GraphExecutionEventType.NODE_STARTED,
  GraphExecutionEventType.NODE_COMPLETED,
  GraphExecutionEventType.NODE_FAILED,
  GraphExecutionEventType.NODE_SKIPPED,
];

/** Formats a timestamp as an ISO-8601 string, when known. */
function isoOf(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Derives the per-node visual state from the engine events for that node,
 * falling back to the node's engine status when no state event was emitted.
 *
 * @param nodeId - The node identifier.
 * @param status - The node's engine status, when known.
 * @param events - The run's ordered engine events.
 * @returns The derived visual state.
 */
export function deriveNodeRunVisualState(
  nodeId: string,
  status: GraphExecutionStatus | string | undefined,
  events: GraphExecutionEvent[] | undefined
): GraphVisualState {
  let derived: GraphVisualState | undefined;
  for (const event of events ?? []) {
    if (event.nodeId !== nodeId) continue;
    if (NODE_STATE_EVENT_TYPES.includes(event.type)) {
      derived = visualStateOfEvent(event);
    }
  }
  return (
    derived ?? mapExecutionStatus(status as GraphExecutionStatus | undefined)
  );
}

/**
 * Builds the run view model for a single node.
 *
 * @param result - The structural node result.
 * @param events - The run's ordered engine events.
 * @returns The node run view model.
 */
export function graphNodeRunViewOf(
  result: GraphRunNodeResultLike,
  events?: GraphExecutionEvent[]
): GraphNodeRunView {
  return {
    nodeId: result.nodeId,
    status: result.status,
    visualState: deriveNodeRunVisualState(
      result.nodeId,
      result.status,
      result.events ?? events
    ),
    inputs: { ...(result.inputs ?? {}) },
    outputs: { ...(result.outputs ?? {}) },
    error: result.error
      ? { code: result.error.code, message: result.error.message }
      : undefined,
    fromCache: result.fromCache === true,
    pinned: result.pinned === true,
    startedAt: isoOf(result.startedAt),
    finishedAt: isoOf(result.finishedAt),
  };
}

/**
 * Builds the run feedback view model for a whole workflow execution.
 *
 * @param result - The structural workflow result.
 * @returns The workflow run view model.
 */
export function graphRunViewOf(result: GraphRunResultLike): GraphWorkflowRunView {
  const nodes: Record<string, GraphNodeRunView> = {};
  for (const [id, nodeResult] of Object.entries(result.nodeResults ?? {})) {
    nodes[id] = graphNodeRunViewOf(nodeResult, result.events);
  }
  return {
    runId: result.runId,
    workflowId: result.workflowId,
    status: result.status,
    visualState: mapExecutionStatus(
      result.status as GraphExecutionStatus | undefined
    ),
    outputs: { ...(result.outputs ?? {}) },
    nodes,
    startedAt: isoOf(result.startedAt),
    finishedAt: isoOf(result.finishedAt),
  };
}
