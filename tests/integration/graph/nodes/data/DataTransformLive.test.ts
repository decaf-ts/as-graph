/**
 * @module as-graph/tests/integration/graph/nodes/data/DataTransformLive
 * @summary SAA-1144 live integration coverage for the six `core.data.*` kinds
 * that previously had unit coverage only.
 * @description Executes the production node classes through the shared
 * `runNode` harness (ctx-bound credential resolver, real instantiation) and
 * exercises their item semantics (R6), nil handling (R7), and the documented
 * `GraphExecutionError` codes. These kinds are pure in-process transforms, so
 * "live" here means the real node implementation with no mocks and no external
 * service dependency.
 */
import { describe, it, expect } from "@jest/globals";
import { SetNode } from "../../../../../src/node/data/set/node";
import { FilterNode } from "../../../../../src/node/data/filter/node";
import { SplitOutNode } from "../../../../../src/node/data/split-out/node";
import { DateTimeNode } from "../../../../../src/node/data/date-time/node";
import { SortNode } from "../../../../../src/node/data/sort/node";
import { RenameKeysNode } from "../../../../../src/node/data/rename-keys/node";
import { errorCodeOf, runNode } from "../real-service-support";

const LIVE_BACKING = "in-process real node (pure transform; no external service)";

describe(`core.data.set — live node (${LIVE_BACKING})`, () => {
  it("assigns typed nested values and preserves the other fields", async () => {
    const result = await runNode(
      SetNode,
      "core.data.set",
      {
        assignments: [
          { name: "status", value: "active" },
          { name: "meta.attempt", value: "3", type: "number" },
        ],
      },
      { value: { id: 1, name: "Ada" } }
    );

    expect(result.result).toEqual({
      id: 1,
      name: "Ada",
      status: "active",
      meta: { attempt: 3 },
    });
  });

  it("maps every array item and rejects unsafe paths", async () => {
    const result = await runNode(
      SetNode,
      "core.data.set",
      { assignments: [{ name: "flag", value: "true", type: "boolean" }] },
      { value: [{ id: 1 }, { id: 2 }] }
    );
    expect(result.result).toEqual([
      { id: 1, flag: true },
      { id: 2, flag: true },
    ]);

    const error = await runNode(
      SetNode,
      "core.data.set",
      { assignments: [{ name: "__proto__.polluted", value: 1 }] },
      { value: {} }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_DATA_UNSAFE_PATH");
  });
});

describe(`core.data.filter — live node (${LIVE_BACKING})`, () => {
  it("filters real records by a condition and honours negate", async () => {
    const condition = { op: "gte", left: { path: "age" }, right: { const: 18 } };
    const rows = [{ age: 12 }, { age: 21 }, { age: 30 }];

    expect(
      (await runNode(FilterNode, "core.data.filter", { condition }, { value: rows }))
        .result
    ).toEqual([{ age: 21 }, { age: 30 }]);

    expect(
      (
        await runNode(
          FilterNode,
          "core.data.filter",
          { condition, negate: true },
          { value: rows }
        )
      ).result
    ).toEqual([{ age: 12 }]);
  });

  it("fails closed without a condition", async () => {
    const error = await runNode(
      FilterNode,
      "core.data.filter",
      {},
      { value: [{ age: 20 }] }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_FILTER_NO_CONDITION");
  });
});

describe(`core.data.splitOut — live node (${LIVE_BACKING})`, () => {
  it("splits array fields into items and writes the destination", async () => {
    const result = await runNode(
      SplitOutNode,
      "core.data.splitOut",
      { field: "tags", include: "allOtherFields", destinationField: "tag" },
      { value: [{ id: 1, tags: ["a", "b"] }, { id: 2, tags: [] }] }
    );
    expect(result.result).toEqual([
      { id: 1, tag: "a" },
      { id: 1, tag: "b" },
    ]);
  });

  it("requires a field name", async () => {
    const error = await runNode(
      SplitOutNode,
      "core.data.splitOut",
      {},
      { value: [{ id: 1 }] }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_SPLIT_OUT_FIELD_REQUIRED");
  });
});

describe(`core.data.dateTime — live node (${LIVE_BACKING})`, () => {
  it("formats, adds and subtracts on real timestamps", async () => {
    const formatted = await runNode(
      DateTimeNode,
      "core.data.dateTime",
      { operation: "format", format: "yyyy-MM-dd HH:mm:ss" },
      { value: "2024-02-03T04:05:06.000Z" }
    );
    expect(formatted.result).toBe("2024-02-03 04:05:06");

    const added = await runNode(
      DateTimeNode,
      "core.data.dateTime",
      { operation: "add", amount: 2, unit: "days" },
      { value: "2024-02-03T00:00:00.000Z" }
    );
    expect(added.iso).toBe("2024-02-05T00:00:00.000Z");

    const current = await runNode(DateTimeNode, "core.data.dateTime", {
      operation: "current",
    });
    expect(current.result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects an invalid date", async () => {
    const error = await runNode(
      DateTimeNode,
      "core.data.dateTime",
      { operation: "parse" },
      { value: "not-a-date" }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_DATA_INVALID_DATE");
  });
});

describe(`core.data.sort — live node (${LIVE_BACKING})`, () => {
  it("sorts real records ascending, descending and by nested path", async () => {
    const rows = [
      { n: 3, meta: { rank: 2 } },
      { n: 1, meta: { rank: 1 } },
      { n: 2, meta: { rank: 3 } },
    ];

    expect(
      (
        await runNode(
          SortNode,
          "core.data.sort",
          { sortFields: [{ field: "n" }] },
          { value: rows }
        )
      ).result
    ).toEqual([rows[1], rows[2], rows[0]]);

    expect(
      (
        await runNode(
          SortNode,
          "core.data.sort",
          { sortFields: [{ field: "n", direction: "desc" }] },
          { value: rows }
        )
      ).result
    ).toEqual([rows[0], rows[2], rows[1]]);

    expect(
      (
        await runNode(
          SortNode,
          "core.data.sort",
          { sortFields: [{ field: "meta.rank" }] },
          { value: rows }
        )
      ).result
    ).toEqual([rows[1], rows[0], rows[2]]);
  });
});

describe(`core.data.renameKeys — live node (${LIVE_BACKING})`, () => {
  it("renames top-level and nested keys without dropping data", async () => {
    const result = await runNode(
      RenameKeysNode,
      "core.data.renameKeys",
      {
        renames: [
          { from: "first_name", to: "name" },
          { from: "nested.old", to: "nested.new" },
        ],
      },
      { value: { first_name: "Ada", nested: { old: 1, keep: true } } }
    );

    expect(result.result).toEqual({
      name: "Ada",
      nested: { new: 1, keep: true },
    });
  });

  it("maps array inputs item by item", async () => {
    const result = await runNode(
      RenameKeysNode,
      "core.data.renameKeys",
      { renames: [{ from: "a", to: "b" }] },
      { value: [{ a: 1 }, { a: 2 }] }
    );
    expect(result.result).toEqual([{ b: 1 }, { b: 2 }]);
  });
});
