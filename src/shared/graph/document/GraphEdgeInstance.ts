import type { GraphEndpoint } from "./GraphEndpoint";
import type { GraphJsonValue } from "./GraphJsonValue";
import type { GraphEdgeUiState } from "./GraphWorkflowUiState";

/**
 * Canonical edge instance in a workflow document (DECAF-50 §4.6): a data or connection edge between two endpoints.
 */
export interface GraphEdgeInstance {
  id: string;
  type: "data" | "connection";
  source: GraphEndpoint;
  target: GraphEndpoint;
  label?: string;
  metadata?: Record<string, GraphJsonValue>;
  ui?: GraphEdgeUiState;
}
