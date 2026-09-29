/**
 * @module as-graph/planning/GraphExecutionPlanLayer
 * @summary A layer of nodes that can execute in parallel.
 * @description Produced by the topological planner; all nodes in a layer have no dependencies on each other.
 */
import type { GraphExecutionPlanNode } from "./GraphExecutionPlanNode";

/**
 * A topological layer of nodes that may execute in parallel.
 */
export interface GraphExecutionPlanLayer {
  index: number;
  nodes: GraphExecutionPlanNode[];
}
