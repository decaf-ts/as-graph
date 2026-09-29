import type { GraphJsonPrimitive } from "../document/GraphJsonValue";
import { isGraphJsonPrimitive } from "../document/GraphJsonValue";

/**
 * The declared visibility-operator vocabulary.
 */
export const GRAPH_VISIBILITY_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "exists",
  "and",
  "or",
  "not",
] as const;

/**
 * The declared visibility-expression operators.
 */
export type GraphVisibilityOperator = (typeof GRAPH_VISIBILITY_OPS)[number];

/**
 * Recursive expression that decides whether a parameter or port is visible from node-instance values.
 */
export type GraphVisibilityExpression =
  | { op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; parameter: string; value: GraphJsonPrimitive }
  | { op: "in" | "notIn"; parameter: string; values: GraphJsonPrimitive[] }
  | { op: "exists"; parameter: string }
  | { op: "and" | "or"; expressions: GraphVisibilityExpression[] }
  | { op: "not"; expression: GraphVisibilityExpression };

const GRAPH_COMPARISON_OPS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;

const GRAPH_ARRAY_OPS = ["in", "notIn"] as const;

const GRAPH_COMPOSITION_OPS = ["and", "or"] as const;

/**
 * Type guard for {@link GraphVisibilityExpression}, checking the fields each operator requires.
  * @returns {boolean} Whether `value` is a GraphVisibilityExpression.
*/
export function isGraphVisibilityExpression(value: unknown): value is GraphVisibilityExpression {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const op = record["op"];
  if (typeof op !== "string") return false;
  if ((GRAPH_COMPARISON_OPS as readonly string[]).includes(op)) {
    return (
      typeof record["parameter"] === "string" &&
      typeof record["value"] !== "undefined" &&
      objectKeysOf(record).length === 3
    );
  }
  if ((GRAPH_ARRAY_OPS as readonly string[]).includes(op)) {
    return (
      typeof record["parameter"] === "string" &&
      Array.isArray(record["values"]) &&
      (record["values"] as unknown[]).every(isPrimitiveOf) &&
      objectKeysOf(record).length === 3
    );
  }
  if (op === "exists") {
    return (
      typeof record["parameter"] === "string" &&
      objectKeysOf(record).length === 2
    );
  }
  if ((GRAPH_COMPOSITION_OPS as readonly string[]).includes(op)) {
    return (
      Array.isArray(record["expressions"]) &&
      (record["expressions"] as unknown[]).every(isGraphVisibilityExpression) &&
      objectKeysOf(record).length === 2
    );
  }
  if (op === "not") {
    return (
      isGraphVisibilityExpression(record["expression"]) &&
      objectKeysOf(record).length === 2
    );
  }
  return false;
}

function isPrimitiveOf(value: unknown): value is GraphJsonPrimitive {
  return isGraphJsonPrimitive(value);
}

function objectKeysOf(record: Record<string, unknown>): string[] {
  return Object.keys(record);
}
