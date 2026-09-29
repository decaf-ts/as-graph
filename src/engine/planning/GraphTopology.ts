/**
 * @module as-graph/planning/GraphTopology
 * @summary Utility helpers for graph topology analysis.
 * @description Provides helper functions used by the planner and pinning dependency resolver.
 */
import type { GraphExecutionPlanEdge } from "./GraphExecutionPlanEdge";

/**
 * Topology utility for traversing the execution plan's edges.
 */
export class GraphTopology {
  /**
   * Returns the set of upstream node ids reachable from `nodeId` by following
   * incoming edges. The workflow boundary node is excluded.
   */
  static upstreamNodes(
    nodeId: string,
    incomingByNode: Map<string, GraphExecutionPlanEdge[]>,
    includeBoundary = false
  ): Set<string> {
    const visited = new Set<string>();
    const stack = [nodeId];
    while (stack.length) {
      const current = stack.pop()!;
      const incoming = incomingByNode.get(current) ?? [];
      for (const edge of incoming) {
        if (!includeBoundary && this.isBoundary(edge.sourceNodeId)) continue;
        if (!visited.has(edge.sourceNodeId)) {
          visited.add(edge.sourceNodeId);
          stack.push(edge.sourceNodeId);
        }
      }
    }
    return visited;
  }

  /**
   * Returns the set of downstream node ids reachable from `nodeId` by following
   * outgoing edges. The workflow boundary node is excluded.
   */
  static downstreamNodes(
    nodeId: string,
    outgoingByNode: Map<string, GraphExecutionPlanEdge[]>,
    includeBoundary = false
  ): Set<string> {
    const visited = new Set<string>();
    const stack = [nodeId];
    while (stack.length) {
      const current = stack.pop()!;
      const outgoing = outgoingByNode.get(current) ?? [];
      for (const edge of outgoing) {
        if (!includeBoundary && this.isBoundary(edge.targetNodeId)) continue;
        if (!visited.has(edge.targetNodeId)) {
          visited.add(edge.targetNodeId);
          stack.push(edge.targetNodeId);
        }
      }
    }
    return visited;
  }

  /** Returns whether a node id is the workflow boundary. */
  static isBoundary(nodeId: string): boolean {
    return nodeId === "$workflow";
  }
}
