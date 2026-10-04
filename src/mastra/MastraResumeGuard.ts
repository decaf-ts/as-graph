/**
 * @module as-graph/mastra/MastraResumeGuard
 * @summary Untrusted-resume validation for the Mastra backend (SAA-193
 * C13/C15/C16/C17/C18).
 * @description Every resume request is validated against the Mastra-authoritative
 * snapshot of the suspended run and the current document fingerprint before any
 * state is handed back to Mastra. Rejections carry specific error codes and the
 * returned audit record carries only identity and provenance — the raw
 * `resumeData` is never logged or echoed.
 */
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import { isGraphJsonSafeValue } from "../shared/graph/document/GraphJsonValue";
import {
  GRAPH_MASTRA_RESUME_INVALID,
  GRAPH_MASTRA_RESUME_STATE_INVALID,
  GRAPH_MASTRA_RESUME_STEP_UNKNOWN,
  type MastraResumeAudit,
  type MastraResumeRequest,
} from "./types";

/**
 * Mastra-authoritative snapshot a suspended run resumes from. Mastra owns the
 * execution state for a suspended workflow (gap-1): this snapshot is the single
 * source of truth for resume, never `GraphRunStore`.
 */
export interface MastraResumeSnapshot {
  /** Canonical run id. */
  runId: string;
  /** Canonical workflow id. */
  workflowId: string;
  /** Fingerprint of the document the run was launched from. */
  documentFingerprint: string;
  /** Mastra run status; resume is only legal from `suspended`. */
  status: string;
  /** Mastra step id the run suspended on. */
  step: string;
  /** Per-iteration index when the suspension happened inside a `foreach`. */
  forEachIndex?: number;
  /** Total iteration count when the suspension happened inside a `foreach`. */
  forEachCount?: number;
  /** Mastra serialized execution state (opaque, engine-authoritative). */
  state: unknown;
}

export interface MastraResumeGuardOptions {
  /** Maximum serialised size, in bytes, of accepted `resumeData`. */
  maxResumeBytes: number;
  /** Node ids the current document declares as resumable. */
  allowlistedSteps: readonly string[];
  /** Fingerprint of the current document. */
  documentFingerprint: string;
  /**
   * Declared resume schema of the suspended node. When present, `resumeData`
   * must validate against it (C15).
   */
  resumeSchema?: { safeParse(value: unknown): { success: boolean } };
}

/**
 * Measures the serialised byte size of a value, treating non-serialisable
 * values as unbounded.
 *
 * @param value - The value to measure.
 * @returns The serialised size in bytes, or infinity when not serialisable.
 */
function serializedSize(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Computes a stable, non-reversible FNV-1a hash of a value for the C18 audit
 * record; the raw value is never logged.
 *
 * @param value - The value to hash.
 * @returns The `fnv1a` hash string with the serialised length.
 */
function stableHash(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}:${text.length}`;
}

/**
 * Validates an untrusted resume request against the Mastra-authoritative
 * snapshot and the current document, enforcing C13/C15/C16/C17 before any state
 * is handed back to Mastra. On success it returns the C18 audit record; the raw
 * `resumeData` is never logged or echoed.
 *
 * @param request - The untrusted resume request to validate.
 * @param snapshot - The Mastra-authoritative suspended-run snapshot.
 * @param options - Document-derived validation options (byte cap, allowlist,
 *   fingerprint, and the suspended step's resume schema).
 * @returns The C18 audit record for the accepted resume.
 * @throws {GraphExecutionError} `GRAPH_MASTRA_RESUME_INVALID` for non-JSON-safe or
 *   oversized `resumeData`; `GRAPH_MASTRA_RESUME_STEP_UNKNOWN` when the suspended
 *   step or iteration is not allowlisted; `GRAPH_MASTRA_RESUME_STATE_INVALID`
 *   when the snapshot is not suspended or its fingerprint does not match.
 */
export function assertMastraResumeAllowed(
  request: MastraResumeRequest,
  snapshot: MastraResumeSnapshot,
  options: MastraResumeGuardOptions
): MastraResumeAudit {
  if (!request || typeof request !== "object") {
    throw new GraphExecutionError(
      "Mastra resume request must be an object",
      GRAPH_MASTRA_RESUME_INVALID,
      { runId: snapshot.runId }
    );
  }

  const size = serializedSize(request.resumeData);
  if (size > options.maxResumeBytes || !isGraphJsonSafeValue(request.resumeData)) {
    throw new GraphExecutionError(
      "Mastra resume data is not JSON-safe or exceeds the byte cap",
      GRAPH_MASTRA_RESUME_INVALID,
      {
        runId: snapshot.runId,
        step: snapshot.step,
        size,
        maxBytes: options.maxResumeBytes,
      }
    );
  }

  if (
    options.resumeSchema &&
    !options.resumeSchema.safeParse(request.resumeData).success
  ) {
    throw new GraphExecutionError(
      "Mastra resume data does not satisfy the suspended step's resume schema",
      GRAPH_MASTRA_RESUME_INVALID,
      { runId: snapshot.runId, step: snapshot.step }
    );
  }

  const allowlisted = new Set(options.allowlistedSteps);
  if (!allowlisted.has(snapshot.step)) {
    throw new GraphExecutionError(
      `Mastra resume step '${snapshot.step}' is not resumable in the current document`,
      GRAPH_MASTRA_RESUME_STEP_UNKNOWN,
      { runId: snapshot.runId, step: snapshot.step }
    );
  }

  const step = request.step ?? snapshot.step;
  if (step !== snapshot.step || !allowlisted.has(step)) {
    throw new GraphExecutionError(
      `Mastra resume step '${String(step)}' does not match the suspended step`,
      GRAPH_MASTRA_RESUME_STEP_UNKNOWN,
      { runId: snapshot.runId, step, suspendedStep: snapshot.step }
    );
  }

  const forEachIndex = request.forEachIndex;
  if (forEachIndex !== undefined) {
    if (
      !Number.isInteger(forEachIndex) ||
      forEachIndex < 0 ||
      (typeof snapshot.forEachCount === "number" &&
        forEachIndex >= snapshot.forEachCount)
    ) {
      throw new GraphExecutionError(
        "Mastra resume iteration index is out of range",
        GRAPH_MASTRA_RESUME_STEP_UNKNOWN,
        {
          runId: snapshot.runId,
          step: snapshot.step,
          forEachIndex,
          forEachCount: snapshot.forEachCount,
        }
      );
    }
  }

  if (
    snapshot.status !== "suspended" ||
    snapshot.documentFingerprint !== options.documentFingerprint ||
    snapshot.state === undefined ||
    snapshot.state === null
  ) {
    throw new GraphExecutionError(
      "Mastra resume snapshot is not a suspended run of the current document",
      GRAPH_MASTRA_RESUME_STATE_INVALID,
      {
        runId: snapshot.runId,
        status: snapshot.status,
        snapshotFingerprint: snapshot.documentFingerprint,
        documentFingerprint: options.documentFingerprint,
      }
    );
  }

  return {
    runId: snapshot.runId,
    workflowId: snapshot.workflowId,
    step: snapshot.step,
    forEachIndex,
    resumeDataHash: stableHash(request.resumeData),
    resumeDataBytes: size,
    at: new Date().toISOString(),
  };
}
