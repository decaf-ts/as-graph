import { createHash } from "node:crypto";
import type { GraphWorkflowDocument } from "../../shared/graph/document/GraphWorkflowDocument";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * Computes a stable SHA-256 fingerprint of a canonical
 * {@link GraphWorkflowDocument}: object keys are sorted and `undefined`
 * values skipped, so documents that serialize identically always produce the
 * same fingerprint regardless of key insertion order.
 */
export function graphRunDocumentFingerprint(
  document: GraphWorkflowDocument
): string {
  return createHash("sha256").update(stableStringify(document)).digest("hex");
}
