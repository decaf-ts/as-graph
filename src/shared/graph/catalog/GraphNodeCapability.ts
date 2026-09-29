/**
 * The declared node-capability vocabulary.
 */
export const GRAPH_NODE_CAPABILITIES = [
  "trigger",
  "loop",
  "branching",
  "stateful",
  "retryable",
  "cancellable",
  "parallel",
  "resource",
] as const;

/**
 * Declared capability of a node kind (DECAF-50 §4.9).
 */
export type GraphNodeCapability = (typeof GRAPH_NODE_CAPABILITIES)[number];

/**
 * Type guard for {@link GraphNodeCapability}.
  * @returns {boolean} Whether `value` is a GraphNodeCapability.
*/
export function isGraphNodeCapability(value: unknown): value is GraphNodeCapability {
  return (GRAPH_NODE_CAPABILITIES as readonly string[]).includes(value as string);
}

/**
 * Type guard for an array of {@link GraphNodeCapability}.
  * @returns {boolean} Whether `value` is a GraphNodeCapability[].
*/
export function isGraphNodeCapabilityArray(value: unknown): value is GraphNodeCapability[] {
  return Array.isArray(value) && value.every(isGraphNodeCapability);
}
