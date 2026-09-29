/**
 * @module as-graph/planning/GraphExecutionPlanNode
 * @summary Plan node type for the execution plan (DECAF-50 §4.9).
 * @description A node fully resolved against the trusted backend catalogue:
 * the canonical instance, the effective (dynamics-expanded) manifest, and
 * the paired executor. The planner never carries raw node definitions.
 */
import type { GraphJsonValue, GraphNodeInstance } from "../../shared/graph";

import type { GraphResolvedNodeManifest } from "../../shared/graph";
import type { GraphNodeExecutor } from "../execution/GraphNodeExecutor";

/**
 * A node in the execution plan, resolved from a
 * {@link GraphResolvedWorkflow} (DECAF-50 §4.9).
 */
export interface GraphExecutionPlanNode {
  id: string;
  kind: string;
  /** The canonical node instance from the workflow document. */
  instance: GraphNodeInstance;
  /** The effective (dynamics-expanded) manifest for the instance. */
  manifest: GraphResolvedNodeManifest;
  /** The trusted executor paired with the kind in the backend catalogue. */
  executor: GraphNodeExecutor;
  inputPorts: string[];
  outputPorts: string[];
  connectionPorts: string[];
  metadata?: Record<string, GraphJsonValue>;
}
