/**
 * @module as-graph/nodes/credentials
 * @summary Credential parsing helpers for token-style comms/devops nodes.
 * @description Shared parsing used by the Stage 3b comms and devops node
 * declarations whose credentials may be either a bare secret (typically an
 * access token) or a JSON object carrying named fields. A bare non-JSON
 * secret is treated as the `token` field, so simple token credentials stay a
 * one-line configuration while structured credentials can carry several
 * fields; JSON secrets that are not objects are rejected outright.
 */
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import { asNonEmptyString, asRecord } from "./storage/support";

/**
 * Parses a resolved secret into a credential record when it holds a JSON object.
 *
 * @param secret - The credential secret string (may be undefined).
 * @param nodeName - Human-readable node name used in error messages.
 * @returns The parsed record, or `undefined` when the secret is absent or not JSON-shaped.
 * @throws {GraphExecutionError} with code `GRAPH_CREDENTIAL_INVALID_FORMAT` when the secret looks like JSON but does not parse to an object.
 */
export function credentialRecord(
  secret: string | undefined,
  nodeName: string
): Record<string, unknown> | undefined {
  if (!secret) return undefined;
  if (!secret.trim().startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(secret);
    const record = asRecord(parsed);
    if (!record) throw new Error("not an object");
    return record;
  } catch {
    throw new GraphExecutionError(
      `${nodeName} node credential must contain a JSON object`,
      "GRAPH_CREDENTIAL_INVALID_FORMAT",
      { node: nodeName }
    );
  }
}

/**
 * Reads one named field from the credential secret.
 *
 * A JSON-object secret is searched for the named field; a bare secret counts
 * as the `token` field only, so any other field name on a bare secret is
 * `undefined`.
 *
 * @param secret - The credential secret string (may be undefined).
 * @param field - Field name to read from a JSON credential.
 * @param nodeName - Human-readable node name used in error messages.
 * @returns The non-empty field value, or `undefined` when absent.
 */
export function credentialValue(
  secret: string | undefined,
  field: string,
  nodeName: string
): string | undefined {
  const record = credentialRecord(secret, nodeName);
  if (!record) return field === "token" ? asNonEmptyString(secret) : undefined;
  return asNonEmptyString(record[field]);
}

/**
 * Reads the token from the credential secret (the `token` field of a JSON credential, or the bare secret itself).
 *
 * @param secret - The credential secret string (may be undefined).
 * @param nodeName - Human-readable node name used in error messages.
 * @returns The non-empty token, or `undefined` when absent.
 */
export function credentialToken(
  secret: string | undefined,
  nodeName: string
): string | undefined {
  return credentialValue(secret, "token", nodeName);
}
