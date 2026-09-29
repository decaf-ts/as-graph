import type { GraphJsonValue } from "./GraphJsonValue";
import { isGraphJsonValue } from "./GraphJsonValue";

/**
 * The declared input-binding modes (`edge`, `literal`, `expression`).
 */
export type GraphInputBindingMode = "edge" | "literal" | "expression";

/**
 * Input binding whose value is taken from an incoming edge.
 */
export type GraphEdgeInputBinding = {
  mode: "edge";
};

/**
 * Input binding whose value is a fixed literal.
 */
export type GraphLiteralInputBinding = {
  mode: "literal";
  value: GraphJsonValue;
};

/**
 * Input binding whose value is an evaluated expression.
 */
export type GraphExpressionInputBinding = {
  mode: "expression";
  expression: string;
};

/**
 * Union of the input-binding kinds.
 */
export type GraphInputBinding =
  | GraphEdgeInputBinding
  | GraphLiteralInputBinding
  | GraphExpressionInputBinding;

/**
 * Per-output binding configuration.
 */
export type GraphOutputBinding = {
  enabled?: boolean;
  alias?: string;
  metadata?: Record<string, GraphJsonValue>;
};

/**
 * Type guard for {@link GraphInputBindingMode}.
  * @returns {boolean} Whether `value` is a GraphInputBindingMode.
*/
export function isGraphInputBindingMode(value: unknown): value is GraphInputBindingMode {
  return value === "edge" || value === "literal" || value === "expression";
}

/**
 * Type guard for {@link GraphInputBinding}, checking the fields each mode requires.
  * @returns {boolean} Whether `value` is a GraphInputBinding.
*/
export function isGraphInputBinding(value: unknown): value is GraphInputBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const mode = (value as Record<string, unknown>)["mode"];
  if (mode === "edge") return Reflect.ownKeys(value).length === 1;
  if (mode === "literal") {
    const value_ = (value as Record<string, unknown>)["value"];
    return (
      Object.keys(value as Record<string, unknown>).length === 2 &&
      isGraphJsonValue(value_)
    );
  }
  if (mode === "expression") {
    return (
      Object.keys(value as Record<string, unknown>).length === 2 &&
      typeof (value as Record<string, unknown>)["expression"] === "string"
    );
  }
  return false;
}
