/**
 * Reference to a stored credential by id and type, carried on a resolved node's credentials (DECAF-50 §4.9).
 */
export interface GraphCredentialReference {
  credentialId: string;
  credentialType: string;
}

/**
 * Type guard for {@link GraphCredentialReference}.
  * @returns {boolean} Whether `value` is a GraphCredentialReference.
*/
export function isGraphCredentialReference(value: unknown): value is GraphCredentialReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["credentialId"] === "string" &&
    typeof record["credentialType"] === "string"
  );
}

export { isGraphCredentialRequirement, type GraphCredentialRequirement } from "./GraphCredentialRequirement";
