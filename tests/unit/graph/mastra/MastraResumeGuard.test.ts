/**
 * @module as-graph/tests/unit/graph/mastra/MastraResumeGuard
 * @summary Driver tests for the Mastra suspend/resume guard (SAA-201 case 4).
 * @description Enumerates SAA-193 C13, C15, C16, C17 and C18 as explicit
 * rejection-code tests plus the C18 audit record shape.
 */
import { assertMastraResumeSchemaSafe, toMastraZodSchema } from "../../../../src/mastra/MastraSchemaConverter";
import {
  assertMastraResumeAllowed,
  type MastraResumeGuardOptions,
  type MastraResumeSnapshot,
} from "../../../../src/mastra/MastraResumeGuard";
import type { MastraResumeRequest } from "../../../../src/mastra/types";
import {
  GRAPH_MASTRA_RESUME_INVALID,
  GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE,
  GRAPH_MASTRA_RESUME_STATE_INVALID,
  GRAPH_MASTRA_RESUME_STEP_UNKNOWN,
} from "../../../../src/mastra/types";
import type { GraphValueSchema } from "../../../../src/shared/graph/catalog/GraphValueSchema";
import { graphCodeOf } from "./helpers";

const SNAPSHOT: MastraResumeSnapshot = {
  runId: "run-1",
  workflowId: "wf-1",
  documentFingerprint: "fp-current",
  status: "suspended",
  step: "approve",
  state: { suspended: true },
};

const OPTIONS: MastraResumeGuardOptions = {
  maxResumeBytes: 32,
  allowlistedSteps: ["approve"],
  documentFingerprint: "fp-current",
};

describe("Mastra resume guard", () => {
  describe("C13 resume schema safety", () => {
    it("rejects a missing resume schema", () => {
      expect(graphCodeOf(() => assertMastraResumeSchemaSafe(undefined))).toBe(
        GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE
      );
    });

    it("rejects a z.any()-degraded resume schema", () => {
      const schema = { type: "any" } as GraphValueSchema;
      expect(graphCodeOf(() => assertMastraResumeSchemaSafe(schema))).toBe(
        GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE
      );
    });

    it("rejects a resume schema degraded by a nested any property", () => {
      const schema = {
        type: "object",
        properties: { value: { type: "any" } },
      } as GraphValueSchema;
      expect(graphCodeOf(() => assertMastraResumeSchemaSafe(schema))).toBe(
        GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE
      );
    });

    it("accepts a declared resume schema and returns a validating zod schema", () => {
      const schema = {
        type: "object",
        properties: { approved: { type: "boolean" } },
      } as GraphValueSchema;

      const zod = assertMastraResumeSchemaSafe(schema);

      expect(zod.safeParse({ approved: true }).success).toBe(true);
      expect(zod.safeParse({ approved: "yes" }).success).toBe(false);
    });

    it("marks an enum with no values as degraded", () => {
      const converted = toMastraZodSchema({
        type: "enum",
        values: [],
      } as GraphValueSchema);
      expect(converted.degraded).toBe(true);
      expect(converted.any).toBe(true);
    });
  });

  describe("C15 resumeData is untrusted input", () => {
    it("rejects resumeData that is not JSON-safe", () => {
      const request = {
        step: "approve",
        resumeData: { callback: () => true },
      } as unknown as MastraResumeRequest;

      expect(graphCodeOf(() => assertMastraResumeAllowed(request, SNAPSHOT, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_INVALID
      );
    });

    it("rejects resumeData carrying a non-finite number", () => {
      const request: MastraResumeRequest = {
        step: "approve",
        resumeData: { value: Number.NaN },
      };

      expect(graphCodeOf(() => assertMastraResumeAllowed(request, SNAPSHOT, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_INVALID
      );
    });

    it("rejects resumeData over the byte cap", () => {
      const request: MastraResumeRequest = {
        step: "approve",
        resumeData: { value: "x".repeat(100) },
      };

      expect(graphCodeOf(() => assertMastraResumeAllowed(request, SNAPSHOT, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_INVALID
      );
    });

    it("rejects a non-object resume request", () => {
      const request = null as unknown as MastraResumeRequest;
      expect(graphCodeOf(() => assertMastraResumeAllowed(request, SNAPSHOT, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_INVALID
      );
    });

    it("rejects a missing resumeData before the allowlist check runs", () => {
      const request: MastraResumeRequest = { step: "other" };
      expect(graphCodeOf(() => assertMastraResumeAllowed(request, SNAPSHOT, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_INVALID
      );
    });
  });

  describe("C16 step/forEachIndex allowlisting", () => {
    it("rejects a suspended step that is not allowlisted", () => {
      const snapshot = { ...SNAPSHOT, step: "other" };
      const request: MastraResumeRequest = { resumeData: { ok: true } };
      expect(graphCodeOf(() => assertMastraResumeAllowed(request, snapshot, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_STEP_UNKNOWN
      );
    });

    it("rejects a requested step that does not match the suspended step", () => {
      const request: MastraResumeRequest = {
        step: "other",
        resumeData: { ok: true },
      };
      expect(graphCodeOf(() => assertMastraResumeAllowed(request, SNAPSHOT, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_STEP_UNKNOWN
      );
    });

    it("rejects a forEachIndex outside the suspended range", () => {
      const snapshot: MastraResumeSnapshot = {
        ...SNAPSHOT,
        forEachIndex: 0,
        forEachCount: 3,
      };
      const request: MastraResumeRequest = {
        step: "approve",
        forEachIndex: 5,
        resumeData: { ok: true },
      };

      expect(graphCodeOf(() => assertMastraResumeAllowed(request, snapshot, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_STEP_UNKNOWN
      );
    });

    it("rejects a non-integer forEachIndex", () => {
      const snapshot: MastraResumeSnapshot = {
        ...SNAPSHOT,
        forEachIndex: 0,
        forEachCount: 3,
      };
      const request: MastraResumeRequest = {
        step: "approve",
        forEachIndex: 1.5,
        resumeData: { ok: true },
      };

      expect(graphCodeOf(() => assertMastraResumeAllowed(request, snapshot, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_STEP_UNKNOWN
      );
    });
  });

  describe("C17 snapshot state is authoritative", () => {
    it("rejects a snapshot that is not suspended", () => {
      const snapshot = { ...SNAPSHOT, status: "running" };
      const request: MastraResumeRequest = { resumeData: { ok: true } };
      expect(graphCodeOf(() => assertMastraResumeAllowed(request, snapshot, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_STATE_INVALID
      );
    });

    it("rejects a snapshot whose fingerprint does not match the current document", () => {
      const snapshot = { ...SNAPSHOT, documentFingerprint: "fp-stale" };
      const request: MastraResumeRequest = { resumeData: { ok: true } };
      expect(graphCodeOf(() => assertMastraResumeAllowed(request, snapshot, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_STATE_INVALID
      );
    });

    it("rejects a snapshot with no execution state", () => {
      const snapshot = { ...SNAPSHOT, state: null };
      const request: MastraResumeRequest = { resumeData: { ok: true } };
      expect(graphCodeOf(() => assertMastraResumeAllowed(request, snapshot, OPTIONS))).toBe(
        GRAPH_MASTRA_RESUME_STATE_INVALID
      );
    });
  });

  describe("C18 resume audit", () => {
    it("returns an audit record and never the raw payload", () => {
      const request: MastraResumeRequest = {
        step: "approve",
        resumeData: { note: "s3cr3t" },
      };

      const audit = assertMastraResumeAllowed(request, SNAPSHOT, OPTIONS);

      expect(audit.runId).toBe("run-1");
      expect(audit.workflowId).toBe("wf-1");
      expect(audit.step).toBe("approve");
      expect(audit.resumeDataHash).toMatch(/^fnv1a:[0-9a-f]{8}:\d+$/);
      expect(audit.resumeDataBytes).toBeGreaterThan(0);
      expect(typeof audit.at).toBe("string");
      expect("resumeData" in audit).toBe(false);
      expect(JSON.stringify(audit)).not.toContain("s3cr3t");
    });

    it("produces a stable hash for identical resumeData", () => {
      const request: MastraResumeRequest = {
        step: "approve",
        resumeData: { approved: true },
      };

      const first = assertMastraResumeAllowed(request, SNAPSHOT, OPTIONS);
      const second = assertMastraResumeAllowed(request, SNAPSHOT, OPTIONS);

      expect(second.resumeDataHash).toBe(first.resumeDataHash);
      expect(second.resumeDataBytes).toBe(first.resumeDataBytes);
    });
  });
});
