/**
 * Credential a node kind requires to run (DECAF-50 §4.9): its type, whether it is mandatory, its display name and the operations it may perform.
 */
export interface GraphCredentialRequirement {
  type: string;
  required?: boolean;
  displayName?: string;
  allowedOperations?: string[];
}

/**
 * Type guard for {@link GraphCredentialRequirement}.
  * @returns {boolean} Whether `value` is a GraphCredentialRequirement.
*/
export function isGraphCredentialRequirement(
  value: unknown
): value is GraphCredentialRequirement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["type"] === "string" &&
    (record["required"] === undefined || typeof record["required"] === "boolean") &&
    (record["displayName"] === undefined || typeof record["displayName"] === "string") &&
    (record["allowedOperations"] === undefined ||
      (Array.isArray(record["allowedOperations"]) &&
        (record["allowedOperations"] as unknown[]).every((entry) => typeof entry === "string")))
  );
}
