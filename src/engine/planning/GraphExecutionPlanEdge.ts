/**
 * @module as-graph/planning/GraphExecutionPlanEdge
 * @summary Plan edge type for the execution plan.
 * @description Represents a directed route between two endpoints
 * (node-to-node or node-to-workflow-boundary) produced by the §4.8 edge
 * validation stage. Data edges route values; connection edges are structural.
 */

/**
 * An edge in the execution plan representing a route from a source port to a
 * target port.
 *
 * `sourceNodeId` or `targetNodeId` may be {@link GRAPH_WORKFLOW_BOUNDARY} when
 * the edge connects to the workflow boundary. `type` distinguishes value
 * routing (`data`) from structural (`connection`) edges.
 */
export interface GraphExecutionPlanEdge {
  id: string;
  /** `data` routes values; `connection` is structural only. */
  type: "data" | "connection";
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  label?: string;
  metadata?: Record<string, unknown>;
}
