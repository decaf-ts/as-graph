/**
 * @module as-graph/shared/graph/document/GraphBinaryReference
 * @summary The JSON-safe shape a binary value takes on the wire.
 * @description Binary data never travels as bytes through a workflow's
 * serialization boundaries (events, run results, persisted runs, pinned
 * values, the editor's input/output panels). A node still produces a
 * {@link GraphBinaryPayload} carrying base64 `data`; the engine moves the bytes
 * into its binary store and every boundary sees the same record with `data`
 * removed and an `id` pointing at the stored bytes — a
 * {@link GraphBinaryReference}. Consumers that need the bytes resolve the `id`
 * through the engine's binary store (or the run binary endpoint).
 *
 * The contract is frontend-safe: a renderer recognises a reference with
 * {@link isGraphBinaryReference} and shows a file entry (name, type, size,
 * view/download) instead of dumping base64 into a JSON view.
 */

/** Prefix of every binary store id. */
export const GRAPH_BINARY_ID_PREFIX = "graph-binary:";

/** Descriptive fields shared by an inline payload and a store reference. */
export interface GraphBinaryDescriptor {
  /** File name, with extension when known. */
  fileName: string;
  /** IANA media type of the bytes. */
  mimeType: string;
  /** Size of the bytes. */
  byteLength: number;
  /** Path the bytes were read from or written to, when there is one. */
  path?: string;
}

/** A binary value carrying its bytes inline as base64. */
export interface GraphBinaryPayload extends GraphBinaryDescriptor {
  /** The bytes, base64-encoded. */
  data: string;
  /** Store id, present once the engine has also stored the bytes. */
  id?: string;
}

/** A binary value whose bytes live in the engine's binary store. */
export interface GraphBinaryReference extends GraphBinaryDescriptor {
  /** Store id (`graph-binary:<digest>`). */
  id: string;
  /** Never present on a reference. */
  data?: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasDescriptor(value: Record<string, unknown>): boolean {
  return (
    typeof value["mimeType"] === "string" &&
    typeof value["byteLength"] === "number"
  );
}

/**
 * Whether a value is a binary payload carrying inline base64 bytes.
 *
 * @param value - The value to inspect.
 * @returns `true` for a record with a media type, a byte length and string
 * `data`.
 */
export function isGraphBinaryPayload(
  value: unknown
): value is GraphBinaryPayload {
  return (
    isRecord(value) && hasDescriptor(value) && typeof value["data"] === "string"
  );
}

/**
 * Whether a value is a store-backed binary reference (no inline bytes).
 *
 * @param value - The value to inspect.
 * @returns `true` for a record with a media type, a byte length, a
 * `graph-binary:` id and no `data`.
 */
export function isGraphBinaryReference(
  value: unknown
): value is GraphBinaryReference {
  return (
    isRecord(value) &&
    hasDescriptor(value) &&
    typeof value["id"] === "string" &&
    (value["id"] as string).startsWith(GRAPH_BINARY_ID_PREFIX) &&
    value["data"] === undefined
  );
}

/**
 * Whether a value contains a binary payload or reference anywhere inside it.
 *
 * @param value - The value to search (records and arrays are walked).
 * @param depth - Remaining recursion depth. Defaults to 8.
 * @returns `true` when at least one binary value was found.
 */
export function containsGraphBinary(value: unknown, depth = 8): boolean {
  if (isGraphBinaryPayload(value) || isGraphBinaryReference(value)) return true;
  if (depth <= 0) return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsGraphBinary(entry, depth - 1));
  }
  if (isRecord(value)) {
    return Object.values(value).some((entry) =>
      containsGraphBinary(entry, depth - 1)
    );
  }
  return false;
}
