/**
 * @module as-graph/pinning/GraphPinningDependencyResolver
 * @summary Resolves upstream dependency subtrees for pinning.
 * @description When a node is pinned, all upstream nodes it depends on must also be pinned. This resolver computes the dependency set.
 */
import type { GraphExecutionPlan } from "../planning/GraphExecutionPlan";
import { GraphTopology } from "../planning/GraphTopology";

/**
 * Resolves the upstream dependency subtree of a node for pinning operations.
 */
export class GraphPinningDependencyResolver {
  /**
   * Returns the set of upstream node ids that the given node depends on,
   * excluding the workflow boundary.
   */
  getDependencies(plan: GraphExecutionPlan, nodeId: string): Set<string> {
    return GraphTopology.upstreamNodes(
      nodeId,
      plan.incomingByNode,
      false
    );
  }

  /**
   * Returns the full set of node ids to pin: the node itself plus all its
   * upstream dependencies.
   */
  getPinSet(plan: GraphExecutionPlan, nodeId: string): Set<string> {
    const deps = this.getDependencies(plan, nodeId);
    deps.add(nodeId);
    return deps;
  }
}
