/**
 * @module as-graph/planning/GraphDependencyTopology
 * @summary Shared dependency-edge and topological-layer rules for graph
 * execution (SAA-1545 §4).
 * @description The planner and the Mastra compiler must agree on which graph
 * edges create execution dependencies and on how cycles are detected. This
 * helper is the single implementation of both rules: it keeps only data and
 * connection edges whose endpoints are executable nodes, then groups those
 * nodes into Kahn layers. Workflow-boundary edges are routing only and never
 * create a node dependency.
 */
import { GRAPH_WORKFLOW_BOUNDARY } from "../constants";
import { GraphCycleError } from "../errors/GraphCycleError";

/**
 * Minimal node shape the topology analysis needs.
 *
 * @description Any object with a stable node id can participate in dependency
 * analysis; executable node instances and plan nodes both satisfy it.
 */
export interface GraphDependencyNodeLike {
  /** The stable node id used to match edges and form layers. */
  id: string;
}

/**
 * Minimal edge shape shared by plan edges and canonical document edges.
 *
 * @description Only `data` and `connection` edges express execution order.
 * Workflow-scoped endpoints are excluded by {@link GraphDependencyTopology.executableEdges}.
 */
export interface GraphDependencyEdgeLike {
  /** The edge category; both data and connection edges are dependencies. */
  type: "data" | "connection";
  /** The id of the node that must execute first. */
  sourceNodeId: string;
  /** The id of the node that depends on the source node. */
  targetNodeId: string;
}

/**
 * Dependency topology shared by the graph planner and the Mastra compiler.
 *
 * @summary Filters dependency edges and computes acyclic topological layers
 * with one shared implementation.
 * @description Both engines must agree on which edges create an execution
 * dependency and on how cycles are detected. A dependency is a data or
 * connection edge between two node-scoped endpoints; workflow-boundary edges
 * are routing only and never a node dependency. A cycle is reported as a
 * {@link GraphCycleError} listing the nodes that could not be planned.
 * @example
 * const layers = GraphDependencyTopology.layers(
 *   [{ id: "a" }, { id: "b" }],
 *   [{ type: "data", sourceNodeId: "a", targetNodeId: "b" }],
 *   "workflow-1"
 * );
 * // layers === [["a"], ["b"]]
 */
export class GraphDependencyTopology {
  /**
   * Filters the edges that create dependencies between executable nodes.
   *
   * @summary Keeps data/connection edges whose endpoints are both executable
   * nodes, excluding the workflow boundary.
   * @template T The concrete edge type being filtered.
   * @param {ReadonlySet<string>} nodeIds - The executable node ids in the workflow.
   * @param {readonly T[]} edges - The candidate edges.
   * @returns {T[]} The edges whose two endpoints are executable nodes.
   */
  static executableEdges<T extends GraphDependencyEdgeLike>(
    nodeIds: ReadonlySet<string>,
    edges: readonly T[]
  ): T[] {
    return edges.filter(
      (edge) =>
        (edge.type === "data" || edge.type === "connection") &&
        !GraphDependencyTopology.isBoundary(edge.sourceNodeId) &&
        !GraphDependencyTopology.isBoundary(edge.targetNodeId) &&
        nodeIds.has(edge.sourceNodeId) &&
        nodeIds.has(edge.targetNodeId)
    );
  }

  /**
   * Groups nodes into Kahn topological layers. Every node in a layer has no
   * dependency on another node in the same layer.
   *
   * @summary Computes ordered execution layers from document order and
   * dependency edges.
   * @description Nodes are processed in document order, so nodes that become
   * ready together keep their relative order. A node appears in exactly one
   * layer. When some nodes can never become ready the graph is cyclic and the
   * call throws instead of returning a partial plan.
   * @param {readonly GraphDependencyNodeLike[]} nodes - The executable nodes in
   * document order.
   * @param {readonly GraphDependencyEdgeLike[]} edges - The candidate edges
   * (workflow-boundary and non-executable edges are ignored).
   * @param {string} [workflowId] - Optional workflow id recorded on a cycle error.
   * @returns {string[][]} The ordered layers of node ids.
   * @throws {GraphCycleError} when the dependency graph contains a cycle.
   * @example
   * const layers = GraphDependencyTopology.layers(
   *   [{ id: "source" }, { id: "a" }, { id: "b" }],
   *   [
   *     { type: "connection", sourceNodeId: "source", targetNodeId: "a" },
   *     { type: "connection", sourceNodeId: "source", targetNodeId: "b" },
   *   ]
   * );
   * // layers === [["source"], ["a", "b"]]
   */
  static layers(
    nodes: readonly GraphDependencyNodeLike[],
    edges: readonly GraphDependencyEdgeLike[],
    workflowId?: string
  ): string[][] {
    const orderedIds = nodes.map((node) => node.id);
    const nodeIds = new Set(orderedIds);
    const dependencyEdges = GraphDependencyTopology.executableEdges(
      nodeIds,
      edges
    );

    const indegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    for (const id of orderedIds) {
      indegree.set(id, 0);
      outgoing.set(id, []);
    }
    for (const edge of dependencyEdges) {
      indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
      outgoing.get(edge.sourceNodeId)!.push(edge.targetNodeId);
    }

    let ready = orderedIds.filter((id) => (indegree.get(id) ?? 0) === 0);
    const layers: string[][] = [];
    const planned = new Set<string>();
    while (ready.length > 0) {
      layers.push([...ready]);
      const nextReady: string[] = [];
      for (const id of ready) {
        planned.add(id);
        for (const target of outgoing.get(id) ?? []) {
          const remaining = (indegree.get(target) ?? 0) - 1;
          indegree.set(target, remaining);
          if (remaining === 0 && !planned.has(target)) nextReady.push(target);
        }
      }
      ready = nextReady;
    }

    if (planned.size !== orderedIds.length) {
      throw new GraphCycleError({
        unplannedNodes: orderedIds.filter((id) => !planned.has(id)),
        ...(workflowId ? { workflowId } : {}),
      });
    }
    return layers;
  }

  /**
   * Whether a node id names the workflow boundary.
   *
   * @summary Recognises the synthetic workflow-boundary endpoint.
   * @param {string} nodeId - The node id to test.
   * @returns {boolean} `true` when the id is the workflow boundary sentinel.
   */
  static isBoundary(nodeId: string): boolean {
    return nodeId === GRAPH_WORKFLOW_BOUNDARY;
  }
}
