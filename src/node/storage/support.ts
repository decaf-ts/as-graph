/**
 * @module as-graph/nodes/storage/support
 * @summary Shared credential and coercion helpers for storage-backed nodes.
 * @description Common utilities used by the Stage 3 storage, database, blob,
 * and credentials-aware node declarations: defensive value coercion for
 * `@input`-hydrated config (`asRecord`, `asNonEmptyString`, `asBoolean`,
 * `asNumber`, `asStringArray`) and the credential plumbing that resolves a
 * workflow credential reference to a `GRAPH_CREDENTIAL_*` environment
 * variable. Credential IDs must name an environment variable directly — the
 * engine never accepts inline secrets — so every consumer receives only the
 * resolved string and re-parses it according to its own credential format.
 */
import type { GraphCredentialReference } from "../../shared/graph";
import type { GraphResolvedCredentials } from "../../engine/types";
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";

/** Shape a credential reference ID must have: a `GRAPH_CREDENTIAL_*` environment variable name. */
export const GRAPH_CREDENTIAL_ENV_PATTERN = /^GRAPH_CREDENTIAL_[A-Z0-9_]+$/;

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
 * Resolves the credential reference under `id` to the secret string held in the
 * corresponding `GRAPH_CREDENTIAL_*` environment variable.
 *
 * The reference must exist when `required` is set, must declare the expected
 * credential type when it declares one, must have an ID that names a
 * `GRAPH_CREDENTIAL_*` environment variable, and the variable must be set at
 * execution time. The resolved secret is returned raw; consumers parse it into
 * their own credential shape (JSON object, connection string, bare token).
 *
 * @param references - Credential references resolved by the engine for this run.
 * @param expectedType - Credential type the node accepts (e.g. `"postgres"`).
 * @param required - Whether execution may proceed without any credential.
 * @param nodeName - Human-readable node name used in error messages.
 * @param id - Handle under which the reference was registered (default `"credentialRef"`).
 * @returns The resolved secret string, or `undefined` when no reference exists and `required` is false.
 * @throws {GraphExecutionError} with code `GRAPH_CREDENTIAL_MISSING` when no reference exists and `required` is true,
 *   `GRAPH_CREDENTIAL_TYPE_MISMATCH` when the reference declares a different credential type,
 *   `GRAPH_CREDENTIAL_INVALID_REFERENCE` when the ID is not a `GRAPH_CREDENTIAL_*` name, and
 *   `GRAPH_CREDENTIAL_NOT_CONFIGURED` when the named environment variable is unset or empty.
 */
export function resolveCredentialSecret(
  references: GraphResolvedCredentials,
  expectedType: string,
  required: boolean,
  nodeName: string,
  id = "credentialRef"
): string | undefined {
  const reference = credentialReference(references, id);
  if (!reference) {
    if (required) {
      throw new GraphExecutionError(
        `${nodeName} node requires a credential of type '${expectedType}'`,
        "GRAPH_CREDENTIAL_MISSING",
        { credentialType: expectedType }
      );
    }
    return undefined;
  }
  if (reference.credentialType && reference.credentialType !== expectedType) {
    throw new GraphExecutionError(
      `${nodeName} node credential '${reference.credentialId}' has type '${reference.credentialType}' but requires '${expectedType}'`,
      "GRAPH_CREDENTIAL_TYPE_MISMATCH",
      { credentialId: reference.credentialId, credentialType: reference.credentialType }
    );
  }
  if (!GRAPH_CREDENTIAL_ENV_PATTERN.test(reference.credentialId)) {
    throw new GraphExecutionError(
      `${nodeName} node credential ID '${reference.credentialId}' must name a GRAPH_CREDENTIAL_* environment variable`,
      "GRAPH_CREDENTIAL_INVALID_REFERENCE",
      { credentialId: reference.credentialId }
    );
  }
  const secret = process.env[reference.credentialId];
  if (!secret) {
    throw new GraphExecutionError(
      `${nodeName} node credential '${reference.credentialId}' is not set in the environment`,
      "GRAPH_CREDENTIAL_NOT_CONFIGURED",
      { credentialId: reference.credentialId }
    );
  }
  return secret;
}

/**
 * Parses a resolved secret that must be a JSON object.
 *
 * @param secret - The credential secret string to parse.
 * @param nodeName - Human-readable node name used in error messages.
 * @returns The parsed credential record.
 * @throws {GraphExecutionError} with code `GRAPH_CREDENTIAL_INVALID_FORMAT` when the secret is not valid JSON or not an object.
 */
export function parseCredentialJson(
  secret: string,
  nodeName: string
): Record<string, unknown> {
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
