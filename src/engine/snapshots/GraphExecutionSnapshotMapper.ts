/**
 * @module as-graph/snapshots/GraphExecutionSnapshotMapper
 * @summary Maps execution results to snapshot patches.
 * @description Produces a GraphExecutionSnapshotPatch consumable by `@decaf-ts/as-graph/shared` snapshots, rather than replacing the snapshot system.
 */
import { GraphExecutionStatus } from "../../shared/graph";
import type {
  GraphExecutionEvent,
} from "../../shared/graph";
import type {
  GraphExecutionResult,
  GraphExecutionSnapshotPatch,
} from "../types";

/**
 * Maps a {@link GraphExecutionResult} to a {@link GraphExecutionSnapshotPatch}.
 */
export class GraphExecutionSnapshotMapper {
  /**
   * Creates a snapshot patch from an execution result.
   */
  map(result: GraphExecutionResult): GraphExecutionSnapshotPatch {
    const nodes: GraphExecutionSnapshotPatch["nodes"] = {};
    for (const [id, nodeResult] of Object.entries(result.nodeResults)) {
      nodes[id] = {
        status: nodeResult.status,
        startedAt: nodeResult.startedAt?.toISOString(),
        finishedAt: nodeResult.finishedAt?.toISOString(),
        error: nodeResult.error,
        outputs: nodeResult.outputs,
        fromCache: nodeResult.fromCache,
        pinned: nodeResult.pinned,
      };
    }

    const edges: GraphExecutionSnapshotPatch["edges"] = {};
    for (const event of result.events) {
      if (event.edgeId && event.type === "edge.valueRouted") {
        edges[event.edgeId] = {
          status: GraphExecutionStatus.SUCCEEDED,
          lastValue: (event.payload as any)?.value,
          updatedAt: event.timestamp.toISOString(),
        };
      }
    }

    const events: GraphExecutionEvent[] = [...result.events];

    return {
      runId: result.runId,
      status: result.status,
      nodes,
      edges,
      outputs: result.outputs,
      events,
    };
  }
}
