import type { GraphJsonValue } from "../document/GraphJsonValue";

/**
 * Custom element metadata for a port: the tag to render and the props to bind (DECAF-50 §4.5).
 */
export interface GraphPortManifestElement {
  tag: string;
  serialize: boolean;
  props: Record<string, GraphJsonValue>;
}

/**
 * Type guard for {@link GraphPortManifestElement}.
  * @returns {boolean} Whether `value` is a GraphPortManifestElement.
*/
export function isGraphPortManifestElement(
  value: unknown
): value is GraphPortManifestElement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["tag"] === "string" &&
    typeof record["serialize"] === "boolean" &&
    typeof record["props"] === "object" &&
    record["props"] !== null &&
    !Array.isArray(record["props"])
  );
}
