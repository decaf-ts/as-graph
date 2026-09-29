import type { GraphJsonValue } from "./GraphJsonValue";
import type { GraphWorkflowDocument } from "./GraphWorkflowDocument";

/**
 * Reference to a loop value: a workflow port, a node port, a literal or an expression.
 */
export type GraphValueReference =
  | { source: "workflow"; port: string }
  | { source: "node"; nodeId: string; port: string }
  | { source: "literal"; value: GraphJsonValue }
  | { source: "expression"; expression: string };

/**
 * Loop body configuration (DECAF-50 §4.5): the nested document plus iteration, timeout, concurrency and I/O mappings.
 */
export interface GraphLoopConfiguration {
  body: GraphWorkflowDocument;
  maxIterations?: number;
  timeoutMs?: number;
  concurrency?: number;
  inputMappings?: Record<string, GraphValueReference>;
  outputMappings?: Record<string, GraphValueReference>;
}
