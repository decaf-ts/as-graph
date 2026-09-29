import type { GraphJsonValue } from "./GraphJsonValue";
import type { GraphNodeInstance } from "./GraphNodeInstance";
import type { GraphEdgeInstance } from "./GraphEdgeInstance";
import type { GraphWorkflowUiState } from "./GraphWorkflowUiState";
import type { GraphValueSchema } from "../catalog/GraphValueSchema";

/**
 * Workflow-level input or output port instance declared on a workflow document.
 */
export interface GraphWorkflowPortInstance {
  id: string;
  label?: string;
  schema?: GraphValueSchema;
  required?: boolean;
  defaultValue?: GraphJsonValue;
  metadata?: Record<string, GraphJsonValue>;
}

/**
 * Free-form workflow settings map.
 */
export type GraphWorkflowSettings = Record<string, GraphJsonValue>;

/**
 * Canonical, serialisable workflow document (DECAF-50 §4.5): id, name, I/O ports, nodes, edges, settings and UI state.
 */
export interface GraphWorkflowDocument {
  id: string;
  name: string;
  inputs: GraphWorkflowPortInstance[];
  outputs: GraphWorkflowPortInstance[];
  nodes: GraphNodeInstance[];
  edges: GraphEdgeInstance[];
  settings?: GraphWorkflowSettings;
  metadata?: Record<string, GraphJsonValue>;
  ui?: GraphWorkflowUiState;
}

/**
 * Type guard for the required shape of a {@link GraphWorkflowDocument}.
  * @returns {boolean} Whether `value` is a {
  id: string;
  name: string;
  inputs: unknown[];
  outputs: unknown[];
  nodes: unknown[];
  edges: unknown[];
}.
*/
export function isGraphWorkflowDocumentShape(value: unknown): value is {
  id: string;
  name: string;
  inputs: unknown[];
  outputs: unknown[];
  nodes: unknown[];
  edges: unknown[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["name"] === "string" &&
    Array.isArray(record["inputs"]) &&
    Array.isArray(record["outputs"]) &&
    Array.isArray(record["nodes"]) &&
    Array.isArray(record["edges"])
  );
}
