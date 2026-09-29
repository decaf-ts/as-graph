/**
 * Port-level connection policy (DECAF-50 §4.5): declarative constraints the canvas and validator enforce for connections into or out of a port.
 */
export interface GraphConnectionPolicy {
  allowSelf?: boolean;
  allowMultiple?: boolean;
  allowedNodeKinds?: string[];
  blockedNodeKinds?: string[];
  allowedPortCategories?: string[];
  maxConnections?: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Type guard for {@link GraphConnectionPolicy}: accepts objects whose list fields are string arrays and whose `maxConnections` is a finite number.
  * @returns {boolean} Whether `value` is a GraphConnectionPolicy.
*/
export function isGraphConnectionPolicy(value: unknown): value is GraphConnectionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record["allowedNodeKinds"] === undefined || isStringArray(record["allowedNodeKinds"])) &&
    (record["blockedNodeKinds"] === undefined || isStringArray(record["blockedNodeKinds"])) &&
    (record["allowedPortCategories"] === undefined ||
      isStringArray(record["allowedPortCategories"])) &&
    (record["maxConnections"] === undefined ||
      (typeof record["maxConnections"] === "number" &&
        Number.isFinite(record["maxConnections"] as number)))
  );
}
