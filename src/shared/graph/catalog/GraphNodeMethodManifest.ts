/**
 * The kinds of backend method a node manifest may expose (DECAF-50 §4.9).
 */
export type GraphNodeMethodType =
  | "loadOptions"
  | "listSearch"
  | "resourceLocator"
  | "resourceMapping"
  | "validateParameter"
  | "action";

/**
 * Manifest entry describing a callable backend method exposed by a node kind (DECAF-50 §4.9).
 */
export interface GraphNodeMethodManifest {
  name: string;
  type: GraphNodeMethodType;
  parameter?: string;
  dependencies?: string[];
}

/**
 * The declared node-method vocabulary.
 */
export const GRAPH_NODE_METHOD_TYPES = [
  "loadOptions",
  "listSearch",
  "resourceLocator",
  "resourceMapping",
  "validateParameter",
  "action",
] as const;

/**
 * Type guard for {@link GraphNodeMethodType}.
  * @returns {boolean} Whether `value` is a GraphNodeMethodType.
*/
export function isGraphNodeMethodType(value: unknown): value is GraphNodeMethodType {
  return (GRAPH_NODE_METHOD_TYPES as readonly string[]).includes(value as string);
}

/**
 * Type guard for {@link GraphNodeMethodManifest}.
  * @returns {boolean} Whether `value` is a GraphNodeMethodManifest.
*/
export function isGraphNodeMethodManifest(value: unknown): value is GraphNodeMethodManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["name"] === "string" &&
    isGraphNodeMethodType(record["type"]) &&
    (record["parameter"] === undefined || typeof record["parameter"] === "string") &&
    (record["dependencies"] === undefined ||
      (Array.isArray(record["dependencies"]) &&
        (record["dependencies"] as unknown[]).every((entry) => typeof entry === "string")))
  );
}
