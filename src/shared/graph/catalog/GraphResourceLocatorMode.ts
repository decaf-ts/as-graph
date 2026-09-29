import type { GraphJsonValue } from "../document/GraphJsonValue";

/**
 * The declared resource-locator mode vocabulary.
 */
export const GRAPH_RESOURCE_LOCATOR_MODES = ["list", "dynamic"] as const;

/**
 * Supported resource-locator lookup modes (`list` or `dynamic`).
 */
export type GraphResourceLocatorMode = (typeof GRAPH_RESOURCE_LOCATOR_MODES)[number];

/**
 * Resource-locator value: the selected mode plus an optional resolved value and placeholder.
 */
export type GraphResourceLocatorValue = {
  mode: GraphResourceLocatorMode;
  value?: GraphJsonValue;
  placeholder?: string;
};

/**
 * Type guard for {@link GraphResourceLocatorMode}.
  * @returns {boolean} Whether `value` is a GraphResourceLocatorMode.
*/
export function isGraphResourceLocatorMode(value: unknown): value is GraphResourceLocatorMode {
  return (GRAPH_RESOURCE_LOCATOR_MODES as readonly string[]).includes(value as string);
}

/**
 * Type guard for {@link GraphResourceLocatorValue}.
  * @returns {boolean} Whether `value` is a GraphResourceLocatorValue.
*/
export function isGraphResourceLocatorValue(
  value: unknown
): value is GraphResourceLocatorValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isGraphResourceLocatorMode(record["mode"]) &&
    (record["value"] === undefined || typeof record["value"] !== "function") &&
    (record["placeholder"] === undefined || typeof record["placeholder"] === "string")
  );
}
