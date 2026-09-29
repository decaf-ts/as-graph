import type { GraphJsonPrimitive } from "../document/GraphJsonValue";
import { isGraphJsonPrimitive } from "../document/GraphJsonValue";

/**
 * One selectable option of an `options` parameter definition.
 */
export interface GraphParameterOption {
  label: string;
  value: GraphJsonPrimitive;
  description?: string;
}

/**
 * Type guard for {@link GraphParameterOption}.
  * @returns {boolean} Whether `value` is a GraphParameterOption.
*/
export function isGraphParameterOption(value: unknown): value is GraphParameterOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["label"] === "string" &&
    isGraphJsonPrimitive(record["value"]) &&
    (record["description"] === undefined || typeof record["description"] === "string")
  );
}

/**
 * Type guard for an array of {@link GraphParameterOption}.
  * @returns {boolean} Whether `value` is a GraphParameterOption[].
*/
export function isGraphParameterOptionArray(value: unknown): value is GraphParameterOption[] {
  return Array.isArray(value) && value.every(isGraphParameterOption);
}
