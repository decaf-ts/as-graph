/**
 * @module as-graph/tests/unit/graph/mastra/MastraMetricsModels
 * @summary Unit evidence for the read-only mastra metric models and the
 * row→model converters (SAA-836 S2).
 * @description Proves the R7 contract on the converters: a raw mastra storage
 * row is either projected into its JSON-safe read-only model or skipped
 * (`undefined`) — never fabricated. Also pins the status derivation from real
 * mastra snapshots (object or serialized JSON string, degrading to `unknown`)
 * and the JSON-safe sanitization of every payload member.
 */
import {
  MASTRA_METRICS_STATUS_UNKNOWN,
  mastraRunRowToModel,
  mastraScoreRowToModel,
  mastraSpanRowToModel,
  type MastraStorageScoreRow,
  type MastraStorageSpanRow,
} from "../../../../src/mastra/MastraMetricsModels";

describe("MastraMetricsModels converters (SAA-836 S2)", () => {
  describe("mastraRunRowToModel", () => {
    it("projects a full run row into its read-only model", () => {
      const createdAt = new Date("2026-01-01T10:00:00Z");
      const model = mastraRunRowToModel(
        {
          runId: "run-1",
          workflowName: "wf-a",
          resourceId: "res-1",
          snapshot: { status: "success", steps: {} },
          createdAt,
          updatedAt: new Date("2026-01-01T10:05:00Z"),
        },
        "wf-a"
      );
      expect(model).toBeDefined();
      expect(model!.runId).toBe("run-1");
      expect(model!.workflowId).toBe("wf-a");
      expect(model!.resourceId).toBe("res-1");
      expect(model!.status).toBe("success");
      expect(model!.snapshot).toEqual({ status: "success", steps: {} });
      expect(model!.createdAt).toEqual(createdAt);
    });

    it("derives the status from a serialized JSON snapshot string", () => {
      const model = mastraRunRowToModel(
        {
          runId: "run-1",
          workflowName: "wf-a",
          snapshot: JSON.stringify({ status: "running" }),
          createdAt: new Date(),
        },
        "wf-a"
      );
      expect(model!.status).toBe("running");
      // The serialized string itself is a JSON-safe value, so it is kept as the
      // sanitized payload (a string is not a plain object, so it is dropped).
      expect(model!.snapshot).toBeUndefined();
    });

    it("degrades an unusable snapshot to the documented unknown status", () => {
      const broken = mastraRunRowToModel(
        {
          runId: "run-1",
          workflowName: "wf-a",
          snapshot: "not-json",
          createdAt: new Date(),
        },
        "wf-a"
      );
      expect(broken!.status).toBe(MASTRA_METRICS_STATUS_UNKNOWN);

      const bare = mastraRunRowToModel(
        {
          runId: "run-2",
          workflowName: "wf-a",
          createdAt: new Date(),
        },
        "wf-a"
      );
      expect(bare!.status).toBe(MASTRA_METRICS_STATUS_UNKNOWN);
      expect(bare!.snapshot).toBeUndefined();
    });

    it("drops a non-JSON-safe snapshot payload without losing the row", () => {
      const model = mastraRunRowToModel(
        {
          runId: "run-1",
          workflowName: "wf-a",
          snapshot: { status: "success", when: new Date(0) },
          createdAt: new Date(),
        },
        "wf-a"
      );
      // R7: the row survives; only the unsafe payload member is dropped.
      expect(model).toBeDefined();
      expect(model!.snapshot).toBeUndefined();
      expect(model!.status).toBe("success");
    });

    it("skips unprojectable rows (R7: never fabricated)", () => {
      expect(mastraRunRowToModel({ runId: "", workflowName: "wf-a" }, "wf-a")).toBeUndefined();
      expect(
        mastraRunRowToModel({ runId: "run-1", createdAt: "nope" }, "wf-a")
      ).toBeUndefined();
      expect(mastraRunRowToModel({}, "wf-a")).toBeUndefined();
    });
  });

  describe("mastraScoreRowToModel", () => {
    it("projects a full score row into its read-only model", () => {
      const model = mastraScoreRowToModel(
        {
          id: "score-1",
          runId: "run-1",
          scorerId: "my-scorer",
          score: 0.75,
          reason: "good",
          input: { foo: "bar" },
          output: { verdict: "ok" },
          createdAt: new Date("2026-01-01T10:00:00Z"),
        },
        "wf-a"
      );
      expect(model).toBeDefined();
      expect(model!.scoreId).toBe("score-1");
      expect(model!.runId).toBe("run-1");
      expect(model!.workflowId).toBe("wf-a");
      expect(model!.scorerId).toBe("my-scorer");
      expect(model!.score).toBe(0.75);
      expect(model!.reason).toBe("good");
      expect(model!.input).toEqual({ foo: "bar" });
      expect(model!.output).toEqual({ verdict: "ok" });
    });

    it("drops non-JSON-safe input/output members but keeps the row", () => {
      const model = mastraScoreRowToModel(
        {
          id: "score-1",
          runId: "run-1",
          scorerId: "my-scorer",
          score: 1,
          input: { fn: () => 1 },
          output: NaN,
          createdAt: new Date(),
        },
        "wf-a"
      );
      expect(model).toBeDefined();
      expect(model!.input).toBeUndefined();
      expect(model!.output).toBeUndefined();
    });

    it("skips rows missing any required member or with a non-finite score", () => {
      const base: MastraStorageScoreRow = {
        id: "score-1",
        runId: "run-1",
        scorerId: "s",
        score: 1,
        createdAt: new Date(),
      };
      expect(mastraScoreRowToModel({ ...base, id: "" }, "wf-a")).toBeUndefined();
      expect(mastraScoreRowToModel({ ...base, runId: "" }, "wf-a")).toBeUndefined();
      expect(mastraScoreRowToModel({ ...base, scorerId: "" }, "wf-a")).toBeUndefined();
      expect(mastraScoreRowToModel({ ...base, createdAt: true }, "wf-a")).toBeUndefined();
      expect(
        mastraScoreRowToModel({ ...base, score: Number.NaN }, "wf-a")
      ).toBeUndefined();
      expect(
        mastraScoreRowToModel({ ...base, score: "high" }, "wf-a")
      ).toBeUndefined();
    });
  });

  describe("mastraSpanRowToModel", () => {
    it("projects a full span row into its read-only trace model", () => {
      const startedAt = new Date("2026-01-01T10:00:00Z");
      const endedAt = new Date("2026-01-01T10:00:05Z");
      const model = mastraSpanRowToModel(
        {
          traceId: "trace-1",
          spanId: "span-1",
          runId: "run-1",
          name: "root span",
          spanType: "workflow",
          status: "success",
          attributes: { a: 1 },
          error: { message: "boom" },
          startedAt,
          endedAt,
        },
        "wf-a"
      );
      expect(model).toBeDefined();
      expect(model!.spanId).toBe("span-1");
      expect(model!.traceId).toBe("trace-1");
      expect(model!.runId).toBe("run-1");
      expect(model!.workflowId).toBe("wf-a");
      expect(model!.name).toBe("root span");
      expect(model!.spanType).toBe("workflow");
      expect(model!.status).toBe("success");
      expect(model!.summary).toEqual({
        attributes: { a: 1 },
        error: { message: "boom" },
      });
      expect(model!.startedAt).toEqual(startedAt);
      expect(model!.endedAt).toEqual(endedAt);
    });

    it("defaults missing spanType/status to unknown and omits an empty summary", () => {
      const model = mastraSpanRowToModel(
        {
          traceId: "trace-1",
          spanId: "span-1",
          runId: "run-1",
          name: "span",
        },
        "wf-a"
      );
      expect(model!.spanType).toBe("unknown");
      expect(model!.status).toBe("unknown");
      expect(model!.summary).toBeUndefined();
      expect(model!.startedAt).toBeUndefined();
      expect(model!.endedAt).toBeUndefined();
    });

    it("skips spans without a run id (cannot be owner-scoped) or other required members", () => {
      const base: MastraStorageSpanRow = {
        traceId: "t",
        spanId: "s",
        runId: "r",
        name: "span",
      };
      expect(mastraSpanRowToModel({ ...base, runId: "" }, "wf-a")).toBeUndefined();
      expect(mastraSpanRowToModel({ ...base, traceId: "" }, "wf-a")).toBeUndefined();
      expect(mastraSpanRowToModel({ ...base, spanId: "" }, "wf-a")).toBeUndefined();
      expect(mastraSpanRowToModel({ ...base, name: "" }, "wf-a")).toBeUndefined();
    });
  });
});
