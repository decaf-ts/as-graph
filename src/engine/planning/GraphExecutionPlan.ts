/**
 * @module as-graph/planning/GraphExecutionPlan
 * @summary The complete execution plan for a workflow (DECAF-50 §4.9).
 * @description Contains the resolved workflow, catalogue-resolved plan nodes,
 * validated edges, topological layers, and incoming/outgoing maps. Plans are
 * produced exclusively from a {@link GraphResolvedWorkflow}.
 */
import type { GraphResolvedWorkflow } from "../validation/GraphResolvedWorkflow";
import type { GraphExecutionPlanNode } from "./GraphExecutionPlanNode";
import type { GraphExecutionPlanEdge } from "./GraphExecutionPlanEdge";
import type { GraphExecutionPlanLayer } from "./GraphExecutionPlanLayer";

/**
 * The resolved execution plan for a single workflow.
 */
export interface GraphExecutionPlan {
  /** The validated, catalogue-resolved workflow this plan was built from. */
  resolved: GraphResolvedWorkflow;
  /** The canonical document id. */
  workflowId: string;
  nodes: GraphExecutionPlanNode[];
  edges: GraphExecutionPlanEdge[];
  layers: GraphExecutionPlanLayer[];
  incomingByNode: Map<string, GraphExecutionPlanEdge[]>;
  outgoingByNode: Map<string, GraphExecutionPlanEdge[]>;
}
