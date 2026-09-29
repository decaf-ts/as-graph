/**
 * @module ui-decorators/graph/GraphExecutionStateMapper
 * @summary Maps engine state to the frontend-safe visual-state contract.
 * @description Pure, engine-agnostic helpers that derive
 * `GraphVisualState` values from engine execution signals. Frontend
 * bundles may import this from `@decaf-ts/ui-decorators/graph` (no
 * engine runtime dependency); a future Mastra/NestJS driver maps its own
 * runtime states onto `GraphVisualState` with the same rules.
 */
import type { GraphExecutionEvent } from "./types";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
  GraphVisualState,
} from "./constants";

/**
 * Maps an engine execution `GraphExecutionStatus` to the shared visual
 * state. `CACHED` collapses onto `GraphVisualState.SUCCEEDED` for
 * rendering; `CANCELLED`/`PENDING`/`PLANNING` yield `IDLE`.
 *
 * @param status - The engine execution status, if any.
 * @returns The visual state for the node/edge.
 */
export function mapExecutionStatus(
  status?: GraphExecutionStatus
): GraphVisualState {
  switch (status) {
    case GraphExecutionStatus.RUNNING:
      return GraphVisualState.RUNNING;
    case GraphExecutionStatus.SUCCEEDED:
    case GraphExecutionStatus.CACHED:
      return GraphVisualState.SUCCEEDED;
    case GraphExecutionStatus.FAILED:
      return GraphVisualState.FAILED;
    case GraphExecutionStatus.SKIPPED:
      return GraphVisualState.SKIPPED;
    case GraphExecutionStatus.PENDING:
    case GraphExecutionStatus.PLANNING:
    case GraphExecutionStatus.CANCELLED:
    default:
      return GraphVisualState.IDLE;
  }
}

/**
 * Options describing a single node's position within a run (DECAF-48 §4.4).
 */
export interface GraphVisualStateDerivation {
  /** Whether the node has already executed (any terminal engine status). */
  executed: boolean;
  /** Whether the node is currently running. */
  running: boolean;
  /** Whether the node completed successfully (or from cache). */
  succeeded?: boolean;
  /** Whether the node failed. */
  failed?: boolean;
  /** Number of incoming edges that have completed value routing. */
  completedUpstreams?: number;
  /** Total number of incoming edges for the node. */
  upstreamCount?: number;
  /** Whether the node is reachable from the workflow inputs in the plan. */
  reachable?: boolean;
  /** Whether the whole run has failed (unexecuted nodes then fade/disable). */
  runFailed?: boolean;
}

/**
 * Derives the visual state for one node from its execution signals.
 *
 * Rules (DECAF-48 §4.4 / Req-5/Req-6):
 * - currently running → `GraphVisualState.RUNNING`
 * - failed → `GraphVisualState.FAILED`
 * - executed and succeeded (or from cache) → `GraphVisualState.SUCCEEDED`
 * - unexecuted and reachable with incomplete upstream deps → `GraphVisualState.BLOCKED`
 * - unexecuted with `runFailed` → `GraphVisualState.SKIPPED` (faded/disabled)
 * - otherwise → `GraphVisualState.IDLE`
 *
 * @param options - The node execution signals.
 * @returns The derived visual state.
 */
export function deriveNodeVisualState(
  options: GraphVisualStateDerivation
): GraphVisualState {
  if (options.running) return GraphVisualState.RUNNING;
  if (options.failed) return GraphVisualState.FAILED;
  if (options.executed && options.succeeded !== false) {
    return options.succeeded
      ? GraphVisualState.SUCCEEDED
      : GraphVisualState.FAILED;
  }

  const upstream = options.upstreamCount ?? 0;
  const completed = options.completedUpstreams ?? 0;
  if (upstream > 0 && completed < upstream) return GraphVisualState.BLOCKED;
  if (options.runFailed) return GraphVisualState.SKIPPED;
  return GraphVisualState.IDLE;
}

/**
 * Translates a `GraphExecutionEvent` into a node visual state when the
 * event carries enough information. Used by contract conformance checks and
 * engine-agnostic consumers that derive state from the shared event stream.
 *
 * @param event - The graph execution event.
 * @returns The corresponding `GraphVisualState`, or `IDLE` when the
 * event does not indicate a specific visual transition.
 */
export function visualStateOfEvent(event: GraphExecutionEvent): GraphVisualState {
  if (event.status) return mapExecutionStatus(event.status);
  const payloadState = (event.payload as { state?: GraphVisualState } | undefined)
    ?.state;
  if (payloadState) return payloadState;
  switch (event.type) {
    case GraphExecutionEventType.NODE_STARTED:
    case GraphExecutionEventType.EDGE_STATE_CHANGED:
    case GraphExecutionEventType.NODE_STATE_CHANGED:
      return GraphVisualState.RUNNING;
    case GraphExecutionEventType.NODE_COMPLETED:
      return GraphVisualState.SUCCEEDED;
    case GraphExecutionEventType.NODE_FAILED:
      return GraphVisualState.FAILED;
    case GraphExecutionEventType.NODE_SKIPPED:
      return GraphVisualState.SKIPPED;
    default:
      return GraphVisualState.IDLE;
  }
}
