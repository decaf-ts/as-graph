/**
 * @module as-graph/tests/unit/graph/mastra/MastraEvalModels
 * @summary Unit evidence for the read-only mastra eval models and the
 * row→model converters (SAA-836 O1, extends S2).
 * @description Proves the R7 contract on the converters: a raw mastra storage
 * row is either projected into its JSON-safe read-only model or skipped
 * (`undefined`) — never fabricated. Also pins the generalized JSON-safe
 * sanitization (arrays and primitives are preserved when JSON-safe, unlike
 * the S2 objects-only payload helper), the degradation constants
 * (`MASTRA_EVAL_STATUS_UNKNOWN` / `MASTRA_EVAL_RESULT_STATUS_UNKNOWN`), and
 * the required-member skip paths.
 */
import {
  MASTRA_EVAL_RESULT_STATUS_UNKNOWN,
  MASTRA_EVAL_STATUS_UNKNOWN,
  mastraExperimentResultRowToModel,
  mastraExperimentRowToModel,
  type MastraStorageExperimentResultRow,
  type MastraStorageExperimentRow,
} from "../../../../src/mastra/MastraEvalModels";

describe("MastraEvalModels converters (SAA-836 O1)", () => {
  describe("mastraExperimentRowToModel", () => {
    it("projects a full experiment row into its read-only model", () => {
      const createdAt = new Date("2026-01-01T10:00:00Z");
      const model = mastraExperimentRowToModel({
        id: "exp-1",
        name: "eval run a",
        description: "the first eval experiment",
        datasetId: "ds-1",
        datasetVersion: 3,
        targetType: "agent",
        targetId: "agent-1",
        scorerIds: ["scorer-a", "scorer-b"],
        status: "running",
        totalItems: 10,
        succeededCount: 7,
        failedCount: 2,
        skippedCount: 1,
        startedAt: new Date("2026-01-01T10:00:05Z"),
        completedAt: new Date("2026-01-01T10:05:00Z"),
        createdAt,
        updatedAt: new Date("2026-01-01T10:06:00Z"),
      });
      expect(model).toBeDefined();
      expect(model!.experimentId).toBe("exp-1");
      expect(model!.name).toBe("eval run a");
      expect(model!.description).toBe("the first eval experiment");
      expect(model!.datasetId).toBe("ds-1");
      expect(model!.datasetVersion).toBe(3);
      expect(model!.targetType).toBe("agent");
      expect(model!.targetId).toBe("agent-1");
      expect(model!.scorerIds).toEqual(["scorer-a", "scorer-b"]);
      expect(model!.status).toBe("running");
      expect(model!.totalItems).toBe(10);
      expect(model!.succeededCount).toBe(7);
      expect(model!.failedCount).toBe(2);
      expect(model!.skippedCount).toBe(1);
      expect(model!.startedAt).toEqual(new Date("2026-01-01T10:00:05Z"));
      expect(model!.completedAt).toEqual(new Date("2026-01-01T10:05:00Z"));
      expect(model!.createdAt).toEqual(createdAt);
      expect(model!.updatedAt).toEqual(new Date("2026-01-01T10:06:00Z"));
    });

    it("degrades a missing status to the documented unknown constant and counts to zero", () => {
      const model = mastraExperimentRowToModel({
        id: "exp-1",
        createdAt: new Date("2026-01-01T10:00:00Z"),
      });
      expect(model).toBeDefined();
      expect(model!.status).toBe(MASTRA_EVAL_STATUS_UNKNOWN);
      expect(model!.totalItems).toBe(0);
      expect(model!.succeededCount).toBe(0);
      expect(model!.failedCount).toBe(0);
      expect(model!.skippedCount).toBe(0);
      // Absent optional members stay absent (mastra uses null for "absent").
      expect(model!.name).toBeUndefined();
      expect(model!.description).toBeUndefined();
      expect(model!.datasetId).toBeUndefined();
      expect(model!.datasetVersion).toBeUndefined();
      expect(model!.targetType).toBeUndefined();
      expect(model!.targetId).toBeUndefined();
      expect(model!.scorerIds).toBeUndefined();
      expect(model!.startedAt).toBeUndefined();
      expect(model!.completedAt).toBeUndefined();
    });

    it("defaults updatedAt to createdAt when the row exposes none", () => {
      const createdAt = new Date("2026-01-01T10:00:00Z");
      const model = mastraExperimentRowToModel({
        id: "exp-1",
        createdAt,
      });
      expect(model!.updatedAt).toEqual(createdAt);
    });

    it("parses string and number mastra storage dates", () => {
      const model = mastraExperimentRowToModel({
        id: "exp-1",
        status: "completed",
        startedAt: "2026-01-01T10:00:05Z",
        completedAt: new Date("2026-01-01T10:00:05Z").getTime(),
        createdAt: "2026-01-01T10:00:00Z",
      });
      expect(model).toBeDefined();
      expect(model!.startedAt).toEqual(new Date("2026-01-01T10:00:05Z"));
      expect(model!.completedAt).toEqual(new Date("2026-01-01T10:00:05Z"));
      expect(model!.createdAt).toEqual(new Date("2026-01-01T10:00:00Z"));
    });

    it("drops unusable members without losing the row", () => {
      const model = mastraExperimentRowToModel({
        id: "exp-1",
        name: "",
        datasetVersion: Number.NaN,
        scorerIds: ["ok", 42] as unknown as string[],
        status: 7 as unknown as string,
        totalItems: -3,
        startedAt: "not-a-date",
        createdAt: new Date("2026-01-01T10:00:00Z"),
      });
      expect(model).toBeDefined();
      expect(model!.name).toBeUndefined();
      expect(model!.datasetVersion).toBeUndefined();
      expect(model!.scorerIds).toBeUndefined();
      expect(model!.status).toBe(MASTRA_EVAL_STATUS_UNKNOWN);
      expect(model!.totalItems).toBe(0);
      expect(model!.startedAt).toBeUndefined();
    });

    it("skips unprojectable rows (R7: never fabricated)", () => {
      const validDates = {
        startedAt: new Date(),
        completedAt: new Date(),
      };
      expect(mastraExperimentRowToModel({ id: "" })).toBeUndefined();
      expect(mastraExperimentRowToModel({ id: "exp-1" })).toBeUndefined();
      expect(
        mastraExperimentRowToModel({ id: "exp-1", createdAt: "nope" })
      ).toBeUndefined();
      expect(
        mastraExperimentRowToModel({
          id: "exp-1",
          createdAt: new Date("not-a-date"),
        })
      ).toBeUndefined();
      expect(mastraExperimentRowToModel({ ...validDates })).toBeUndefined();
      expect(mastraExperimentRowToModel({})).toBeUndefined();
    });
  });

  describe("mastraExperimentResultRowToModel", () => {
    const baseDates = {
      startedAt: new Date("2026-01-01T10:00:00Z"),
      completedAt: new Date("2026-01-01T10:00:10Z"),
      createdAt: new Date("2026-01-01T10:00:00Z"),
    };

    it("projects a full result row into its read-only model", () => {
      const model = mastraExperimentResultRowToModel({
        id: "res-1",
        experimentId: "exp-1",
        itemId: "item-7",
        itemDatasetVersion: 3,
        input: { prompt: "hello" },
        output: { answer: "world" },
        groundTruth: { answer: "world" },
        error: { message: "boom" },
        attempt: 1,
        retryCount: 2,
        status: "failed",
        traceId: "trace-9",
        tags: ["review-me"],
        ...baseDates,
      });
      expect(model).toBeDefined();
      expect(model!.resultId).toBe("res-1");
      expect(model!.experimentId).toBe("exp-1");
      expect(model!.itemId).toBe("item-7");
      expect(model!.itemDatasetVersion).toBe(3);
      expect(model!.input).toEqual({ prompt: "hello" });
      expect(model!.output).toEqual({ answer: "world" });
      expect(model!.groundTruth).toEqual({ answer: "world" });
      expect(model!.error).toEqual({ message: "boom" });
      expect(model!.attempt).toBe(1);
      expect(model!.retryCount).toBe(2);
      expect(model!.status).toBe("failed");
      expect(model!.traceId).toBe("trace-9");
      expect(model!.tags).toEqual(["review-me"]);
      expect(model!.startedAt).toEqual(baseDates.startedAt);
      expect(model!.completedAt).toEqual(baseDates.completedAt);
      expect(model!.createdAt).toEqual(baseDates.createdAt);
    });

    it("preserves JSON-safe arrays and primitives in the payload triple (generalized helper, unlike S2's objects-only one)", () => {
      const model = mastraExperimentResultRowToModel({
        id: "res-1",
        experimentId: "exp-1",
        itemId: "item-7",
        input: [1, "two", { three: 3 }],
        output: "plain output",
        groundTruth: 42,
        ...baseDates,
      });
      expect(model).toBeDefined();
      expect(model!.input).toEqual([1, "two", { three: 3 }]);
      expect(model!.output).toBe("plain output");
      expect(model!.groundTruth).toBe(42);
    });

    it("drops non-JSON-safe payload members without losing the row", () => {
      const model = mastraExperimentResultRowToModel({
        id: "res-1",
        experimentId: "exp-1",
        itemId: "item-7",
        input: { when: new Date(0) },
        output: Number.NaN,
        groundTruth: () => "nope",
        ...baseDates,
      });
      expect(model).toBeDefined();
      expect(model!.input).toBeUndefined();
      expect(model!.output).toBeUndefined();
      expect(model!.groundTruth).toBeUndefined();
      expect(model!.status).toBe(MASTRA_EVAL_RESULT_STATUS_UNKNOWN);
    });

    it("keeps only object-shaped JSON-safe errors", () => {
      const objectError = mastraExperimentResultRowToModel({
        id: "res-1",
        experimentId: "exp-1",
        itemId: "item-7",
        error: { message: "boom", code: 500 },
        ...baseDates,
      });
      expect(objectError!.error).toEqual({ message: "boom", code: 500 });

      const arrayError = mastraExperimentResultRowToModel({
        id: "res-1",
        experimentId: "exp-1",
        itemId: "item-7",
        error: ["not", "an", "object"],
        ...baseDates,
      });
      expect(arrayError).toBeDefined();
      expect(arrayError!.error).toBeUndefined();

      const unsafeError = mastraExperimentResultRowToModel({
        id: "res-1",
        experimentId: "exp-1",
        itemId: "item-7",
        error: { at: new Date(0) },
        ...baseDates,
      });
      expect(unsafeError).toBeDefined();
      expect(unsafeError!.error).toBeUndefined();
    });

    it("degrades a missing status to the documented unknown constant and counts to zero", () => {
      const model = mastraExperimentResultRowToModel({
        id: "res-1",
        experimentId: "exp-1",
        itemId: "item-7",
        ...baseDates,
      });
      expect(model).toBeDefined();
      expect(model!.status).toBe(MASTRA_EVAL_RESULT_STATUS_UNKNOWN);
      expect(model!.attempt).toBe(0);
      expect(model!.retryCount).toBe(0);
      expect(model!.itemDatasetVersion).toBeUndefined();
      expect(model!.traceId).toBeUndefined();
      expect(model!.tags).toBeUndefined();
    });

    it("skips rows missing any required member (R7: never fabricated)", () => {
      const base: MastraStorageExperimentResultRow = {
        id: "res-1",
        experimentId: "exp-1",
        itemId: "item-7",
        ...baseDates,
      };
      expect(
        mastraExperimentResultRowToModel({ ...base, id: "" })
      ).toBeUndefined();
      expect(
        mastraExperimentResultRowToModel({ ...base, experimentId: "" })
      ).toBeUndefined();
      expect(
        mastraExperimentResultRowToModel({ ...base, itemId: "" })
      ).toBeUndefined();
      expect(
        mastraExperimentResultRowToModel({ ...base, startedAt: null })
      ).toBeUndefined();
      expect(
        mastraExperimentResultRowToModel({ ...base, completedAt: "nope" })
      ).toBeUndefined();
      expect(
        mastraExperimentResultRowToModel({ ...base, createdAt: undefined })
      ).toBeUndefined();
      expect(
        mastraExperimentResultRowToModel({ id: "res-1" } as MastraStorageExperimentRow)
      ).toBeUndefined();
      expect(mastraExperimentResultRowToModel({})).toBeUndefined();
    });
  });
});
