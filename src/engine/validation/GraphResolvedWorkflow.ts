/**
 * @module as-graph/engine/validation/GraphResolvedWorkflow
 * @summary Backend-only resolved workflow types (DECAF-50 §4.8/§4.9).
 * @description A {@link GraphResolvedWorkflow} is a canonical
 * {@link GraphWorkflowDocument} whose node kinds have been resolved against
 * the trusted backend catalogue (manifest + executor + dynamic ports) and
 * whose edges have been flattened into resolved endpoints. It is the ONLY
 * input the {@link GraphExecutionPlanner} accepts.
 */
import type {
  GraphEdgeInstance,
  GraphJsonValue,
  GraphNodeInstance,
  GraphWorkflowDocument,
} from "../../shared/graph";

import type { GraphNodeExecutor } from "../execution/GraphNodeExecutor";
import type { GraphResolvedNodeManifest } from "../../shared/graph";

/**
 * A node instance resolved against the backend catalogue.
 */
export interface GraphResolvedNodeInstance {
  /** The canonical node instance from the document. */
  instance: GraphNodeInstance;
  /** The effective (dynamics-expanded) manifest for the instance. */
  manifest: GraphResolvedNodeManifest;
  /** The trusted executor paired with the kind in the catalogue. */
  executor: GraphNodeExecutor;
}

/**
 * An edge instance with flattened endpoints. Workflow-scope endpoints use
 * the `GRAPH_WORKFLOW_BOUNDARY` node id (`"$workflow"`) so the value store's
 * boundary bucket keeps working unchanged.
 */
export interface GraphResolvedEdgeInstance {
  /** Edge id (unique within the document). */
  id: string;
  /** `data` or `connection`. */
  type: "data" | "connection";
  /** Source node id, or the workflow boundary id for workflow inputs. */
  sourceNodeId: string;
  /** Source port id (workflow input port or node output/connection port). */
  sourcePort: string;
  /** Target node id, or the workflow boundary id for workflow outputs. */
  targetNodeId: string;
  /** Target port id (workflow output port or node input/connection port). */
  targetPort: string;
  /** Optional edge label. */
  label?: string;
  /** Edge-owned metadata permitted by the shared contract. */
  metadata?: Record<string, GraphJsonValue>;
  /** The canonical edge instance from the document. */
  edge: GraphEdgeInstance;
}

/**
 * A canonical workflow document fully resolved against the backend catalogue.
 * Backend-only — never serialised to clients.
 */
export interface GraphResolvedWorkflow {
  /** The canonical document that was validated. */
  document: GraphWorkflowDocument;
  /** Resolved node instances, in document order. */
  nodes: GraphResolvedNodeInstance[];
  /** Resolved edge instances, in document order. */
  edges: GraphResolvedEdgeInstance[];
  /** Node lookup by id. */
  nodeById: Map<string, GraphResolvedNodeInstance>;
  /** Incoming edges per node id (boundary excluded from keys). */
  incomingByNode: Map<string, GraphResolvedEdgeInstance[]>;
  /** Outgoing edges per node id (boundary excluded from keys). */
  outgoingByNode: Map<string, GraphResolvedEdgeInstance[]>;
}
