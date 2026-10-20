/**
 * @module as-graph/nodes/storage/support
 * @summary Shared credential and coercion helpers for storage-backed nodes.
 * @description Common utilities used by the Stage 3 storage, database, blob,
 * and credentials-aware node declarations: defensive value coercion for
 * `@input`-hydrated config (`asRecord`, `asNonEmptyString`, `asBoolean`,
 * `asNumber`, `asStringArray`) and the credential reference plumbing shared by
 * the storage-backed nodes. Consumers resolve credentials through the ctx-bound
 * engine resolver and re-parse the returned secret according to their own
 * credential format.
 */
import type { GraphCredentialReference } from "../../shared/graph";
import type { GraphResolvedCredentials } from "../../engine/types";
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
export { resolveNodeCredential } from "../../engine/credentials/GraphNodeCredentials";

/** Narrows a value to a plain object (arrays excluded); anything else is `undefined`. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Returns the value when it is a non-blank string (trimmed); anything else is `undefined`. */
export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Coerces a boolean-ish config value (real boolean or `"true"`/`"false"` string), falling back when unrecognized. */
export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

/** Coerces a finite number or numeric string; anything else is `undefined`. */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Returns the value only when it is already an array; anything else is `undefined`. */
export function asStringArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Looks up a credential reference in the run's resolved credentials, defaulting to the `credentialRef` handle. */
export function credentialReference(
  references: GraphResolvedCredentials,
  id = "credentialRef"
): GraphCredentialReference | undefined {
  return references[id];
}

/**
 * Parses a resolved secret that must be a JSON object. An already-resolved
 * record passes through; a string is parsed as JSON.
 *
 * @param secret - The credential secret (JSON string or record) to parse.
 * @param nodeName - Human-readable node name used in error messages.
 * @returns The parsed credential record.
 * @throws {GraphExecutionError} with code `GRAPH_CREDENTIAL_INVALID_FORMAT` when the secret is not valid JSON or not an object.
 */
export function parseCredentialJson(
  secret: string | Record<string, unknown>,
  nodeName: string
): Record<string, unknown> {
  try {
    const record = asRecord(secret);
    if (record) return record;
    const parsed = JSON.parse(secret as string);
    const parsedRecord = asRecord(parsed);
    if (!parsedRecord) throw new Error("not an object");
    return parsedRecord;
  } catch {
    throw new GraphExecutionError(
      `${nodeName} node credential must contain a JSON object`,
      "GRAPH_CREDENTIAL_INVALID_FORMAT",
      { node: nodeName }
    );
  }
}
