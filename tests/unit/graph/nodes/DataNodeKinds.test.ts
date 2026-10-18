/**
 * @module as-graph/tests/unit/graph/nodes/DataNodeKinds.test
 * @summary Unit coverage for the SAA-746 Stage 1 general-engine data nodes.
 * @description Exercises the instance `execute` contract of every `core.data.*`
 * kind registered for the general engine: normal path, array-in/array-out item
 * semantics (R6), nil/empty input behaviour (R7), and the documented
 * `GraphExecutionError` failure codes. Config is hydrated through the production
 * `nodeClass.instantiate(graphNodeConfig(...))` path via `executeNode`.
 */
import { describe, it, expect } from "@jest/globals";

import {
  DateTimeNode,
  FilterNode,
  LimitNode,
  MergeNode,
  RenameKeysNode,
  SetNode,
  SortNode,
  SplitOutNode,
} from "../../../../src/node";
import type { GraphNodeClass } from "../../../../src/node/base";
import type { GraphExecutionValues } from "../../../../src/engine/types";
import type {
  ConditionExpression,
} from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

async function run(
  nodeClass: GraphNodeClass,
  kind: string,
  parameters: Record<string, unknown>,
  inputs: Record<string, unknown>
): Promise<GraphExecutionValues> {
  const context = buildNodeContext(kind, { parameters });
  return await executeNode(nodeClass, nodeExecutionRequest(inputs), context);
}

describe("core.data.set", () => {
  const kind = "core.data.set";

  it("assigns configured values and keeps the incoming fields by default", async () => {
    const result = await run(
      SetNode,
      kind,
      {
        assignments: [
          { name: "status", value: "active" },
          { name: "meta.attempt", value: "3", type: "number" },
        ],
      },
      { value: { id: 1, name: "Ada" } }
    );
    expect(result).toEqual({
      result: { id: 1, name: "Ada", status: "active", meta: { attempt: 3 } },
    });
  });

  it("returns an array for an array input (R6)", async () => {
    const result = await run(
      SetNode,
      kind,
      { assignments: [{ name: "flag", value: "true", type: "boolean" }] },
      { value: [{ id: 1 }, { id: 2 }] }
    );
    expect(result.result).toEqual([
      { id: 1, flag: true },
      { id: 2, flag: true },
    ]);
  });

  it("omits other fields when includeOtherFields is false", async () => {
    const result = await run(
      SetNode,
      kind,
      { includeOtherFields: false, assignments: [{ name: "only", value: "x" }] },
      { value: { discarded: true } }
    );
    expect(result.result).toEqual({ only: "x" });
  });

  it("treats nil and empty input as empty results (R7)", async () => {
    expect(await run(SetNode, kind, {}, {})).toEqual({ result: {} });
    expect(await run(SetNode, kind, {}, { value: [] })).toEqual({ result: [] });
  });

  it("rejects unsafe dot-notation paths", async () => {
    await expect(
      run(
        SetNode,
        kind,
        { assignments: [{ name: "__proto__.polluted", value: 1 }] },
        { value: {} }
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_DATA_UNSAFE_PATH" });
  });

  it("rejects values that cannot be coerced to a number", async () => {
    await expect(
      run(
        SetNode,
        kind,
        { assignments: [{ name: "n", value: "abc", type: "number" }] },
        { value: {} }
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_DATA_INVALID_NUMBER" });
  });
});

describe("core.data.merge", () => {
  const kind = "core.data.merge";

  it("appends both inputs in append mode", async () => {
    const result = await run(
      MergeNode,
      kind,
      { mode: "append" },
      { input: [1, 2], input2: [3, 4] }
    );
    expect(result).toEqual({ result: [1, 2, 3, 4] });
  });

  it("combines records positionally", async () => {
    const result = await run(
      MergeNode,
      kind,
      { mode: "combine", combineBy: "position" },
      { input: [{ a: 1 }, { a: 2 }], input2: [{ b: 1 }, { b: 2 }] }
    );
    expect(result.result).toEqual([
      { a: 1, b: 1 },
      { a: 2, b: 2 },
    ]);
  });

  it("honours clash handling and non-record pairs in positional combine", async () => {
    const keepFirst = await run(
      MergeNode,
      kind,
      { mode: "combine", clashHandling: "keepFirst" },
      { input: [{ id: 1, side: "left" }], input2: [{ id: 1, side: "right" }] }
    );
    expect(keepFirst.result).toEqual([{ id: 1, side: "left" }]);

    const keepLast = await run(
      MergeNode,
      kind,
      { mode: "combine", clashHandling: "keepLast" },
      { input: [{ id: 1, side: "left" }], input2: [{ id: 1, side: "right" }] }
    );
    expect(keepLast.result).toEqual([{ id: 1, side: "right" }]);

    const scalars = await run(
      MergeNode,
      kind,
      { mode: "combine", combineBy: "position" },
      { input: [1], input2: [2] }
    );
    expect(scalars.result).toEqual([[1, 2]]);
  });

  it("joins records by field across inner/left/right/outer modes", async () => {
    const input = [
      { id: 1, left: "a" },
      { id: 2, left: "b" },
    ];
    const input2 = [
      { id: 2, right: "x" },
      { id: 3, right: "y" },
    ];

    const inner = await run(
      MergeNode,
      kind,
      { mode: "combine", combineBy: "fields", joinField: "id", joinMode: "inner" },
      { input, input2 }
    );
    expect(inner.result).toEqual([{ id: 2, left: "b", right: "x" }]);

    const left = await run(
      MergeNode,
      kind,
      { mode: "combine", combineBy: "fields", joinField: "id", joinMode: "left" },
      { input, input2 }
    );
    expect(left.result).toEqual([
      { id: 1, left: "a" },
      { id: 2, left: "b", right: "x" },
    ]);

    const right = await run(
      MergeNode,
      kind,
      { mode: "combine", combineBy: "fields", joinField: "id", joinMode: "right" },
      { input, input2 }
    );
    expect(right.result).toEqual([
      { id: 2, left: "b", right: "x" },
      { id: 3, right: "y" },
    ]);

    const outer = await run(
      MergeNode,
      kind,
      { mode: "combine", combineBy: "fields", joinField: "id", joinMode: "outer" },
      { input, input2 }
    );
    expect(outer.result).toEqual([
      { id: 1, left: "a" },
      { id: 2, left: "b", right: "x" },
      { id: 3, right: "y" },
    ]);
  });

  it("returns empty results for nil inputs (R7)", async () => {
    expect(await run(MergeNode, kind, {}, {})).toEqual({ result: [] });
    expect(
      await run(MergeNode, kind, { mode: "combine", combineBy: "fields", joinField: "id" }, {})
    ).toEqual({ result: [] });
  });

  it("requires a join field in fields mode", async () => {
    await expect(
      run(
        MergeNode,
        kind,
        { mode: "combine", combineBy: "fields" },
        { input: [{ id: 1 }], input2: [{ id: 1 }] }
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_MERGE_JOIN_FIELD_REQUIRED" });
  });
});

describe("core.data.filter", () => {
  const kind = "core.data.filter";
  const adult: ConditionExpression = {
    op: "gte",
    left: { path: "age" },
    right: { const: 18 },
  };

  it("keeps records that match the condition and returns an array (R6)", async () => {
    const result = await run(
      FilterNode,
      kind,
      { condition: adult },
      { value: [{ age: 12 }, { age: 21 }, { age: 18 }] }
    );
    expect(result.result).toEqual([{ age: 21 }, { age: 18 }]);
  });

  it("inverts the match set when negate is set", async () => {
    const result = await run(
      FilterNode,
      kind,
      { condition: adult, negate: true },
      { value: [{ age: 12 }, { age: 21 }] }
    );
    expect(result.result).toEqual([{ age: 12 }]);
  });

  it("wraps a scalar input as a single-item array", async () => {
    const result = await run(
      FilterNode,
      kind,
      { condition: { op: "eq", left: { path: "id" }, right: { const: 7 } } },
      { value: { id: 7 } }
    );
    expect(result.result).toEqual([{ id: 7 }]);
  });

  it("returns an empty array for nil input (R7)", async () => {
    expect(await run(FilterNode, kind, { condition: adult }, {})).toEqual({
      result: [],
    });
  });

  it("fails with GRAPH_FILTER_NO_CONDITION when no condition is configured", async () => {
    await expect(
      run(FilterNode, kind, {}, { value: [{ age: 20 }] })
    ).rejects.toMatchObject({ graphCode: "GRAPH_FILTER_NO_CONDITION" });
  });
});

describe("core.data.splitOut", () => {
  const kind = "core.data.splitOut";

  it("splits an array field into one result per entry", async () => {
    const result = await run(
      SplitOutNode,
      kind,
      { field: "tags" },
      {
        value: [
          { id: 1, tags: ["a", "b"] },
          { id: 2, tags: [] },
          { id: 3, tags: null },
          { id: 4, tags: "solo" },
        ],
      }
    );
    expect(result.result).toEqual(["a", "b", "solo"]);
  });

  it("keeps the other fields and writes the entry to the destination field", async () => {
    const result = await run(
      SplitOutNode,
      kind,
      { field: "tags", include: "allOtherFields", destinationField: "tag" },
      { value: [{ id: 1, tags: ["a", "b"] }] }
    );
    expect(result.result).toEqual([
      { id: 1, tag: "a" },
      { id: 1, tag: "b" },
    ]);
  });

  it("returns an empty array for nil input (R7)", async () => {
    expect(await run(SplitOutNode, kind, { field: "tags" }, {})).toEqual({
      result: [],
    });
  });

  it("requires a field name", async () => {
    await expect(
      run(SplitOutNode, kind, {}, { value: [{ id: 1 }] })
    ).rejects.toMatchObject({ graphCode: "GRAPH_SPLIT_OUT_FIELD_REQUIRED" });
  });
});

describe("core.data.dateTime", () => {
  const kind = "core.data.dateTime";

  it("returns a formatted current timestamp", async () => {
    const result = await run(
      DateTimeNode,
      kind,
      { operation: "current", format: "yyyy-MM-dd" },
      {}
    );
    expect(result.result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof result.iso).toBe("string");
    expect(typeof result.timestamp).toBe("number");
  });

  it("parses and formats a supplied date", async () => {
    const result = await run(
      DateTimeNode,
      kind,
      { operation: "format", format: "yyyy-MM-dd HH:mm:ss" },
      { value: "2024-02-03T04:05:06.000Z" }
    );
    expect(result).toEqual({
      result: "2024-02-03 04:05:06",
      iso: "2024-02-03T04:05:06.000Z",
      timestamp: Date.parse("2024-02-03T04:05:06.000Z"),
    });
  });

  it("adds and subtracts configured units", async () => {
    const added = await run(
      DateTimeNode,
      kind,
      { operation: "add", amount: 2, unit: "days" },
      { value: "2024-02-03T00:00:00.000Z" }
    );
    expect(added.iso).toBe("2024-02-05T00:00:00.000Z");

    const subtracted = await run(
      DateTimeNode,
      kind,
      { operation: "subtract", amount: 1, unit: "months" },
      { value: "2024-02-15T00:00:00.000Z" }
    );
    expect(subtracted.iso).toBe("2024-01-15T00:00:00.000Z");
  });

  it("maps arrays positionally (R6)", async () => {
    const result = await run(
      DateTimeNode,
      kind,
      { operation: "parse" },
      { value: ["2024-01-01T00:00:00.000Z", "2024-06-01T00:00:00.000Z"] }
    );
    expect(result.result).toEqual([
      "2024-01-01T00:00:00.000Z",
      "2024-06-01T00:00:00.000Z",
    ]);
    expect(result.iso).toEqual(result.result);
    expect(result.timestamp).toHaveLength(2);
  });

  it("uses the configured value when no input is routed", async () => {
    const result = await run(
      DateTimeNode,
      kind,
      { operation: "parse", value: "2024-12-25T00:00:00.000Z" },
      {}
    );
    expect(result.iso).toBe("2024-12-25T00:00:00.000Z");
  });

  it("rejects invalid dates and unsupported operations", async () => {
    await expect(
      run(DateTimeNode, kind, { operation: "parse" }, { value: "not-a-date" })
    ).rejects.toMatchObject({ graphCode: "GRAPH_DATA_INVALID_DATE" });

    await expect(
      run(DateTimeNode, kind, { operation: "bogus" }, { value: "2024-01-01" })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_DATE_TIME_UNSUPPORTED_OPERATION",
    });
  });
});

describe("core.data.limit", () => {
  const kind = "core.data.limit";

  it("keeps the first or last N items", async () => {
    const first = await run(
      LimitNode,
      kind,
      { maxItems: 2 },
      { value: [1, 2, 3, 4] }
    );
    expect(first.result).toEqual([1, 2]);

    const last = await run(
      LimitNode,
      kind,
      { maxItems: 2, keep: "lastItems" },
      { value: [1, 2, 3, 4] }
    );
    expect(last.result).toEqual([3, 4]);
  });

  it("returns everything when the limit exceeds the item count", async () => {
    const result = await run(
      LimitNode,
      kind,
      { maxItems: 10 },
      { value: [1, 2] }
    );
    expect(result.result).toEqual([1, 2]);
  });

  it("returns an empty array at zero and for nil input (R7)", async () => {
    expect(await run(LimitNode, kind, { maxItems: 0 }, { value: [1, 2] })).toEqual({
      result: [],
    });
    expect(await run(LimitNode, kind, {}, {})).toEqual({ result: [] });
  });

  it("wraps scalars into a single-item array (R6)", async () => {
    expect(await run(LimitNode, kind, { maxItems: 5 }, { value: "x" })).toEqual({
      result: ["x"],
    });
  });
});

describe("core.data.sort", () => {
  const kind = "core.data.sort";

  it("sorts ascending and descending by field", async () => {
    const items = [{ n: 3 }, { n: 1 }, { n: 2 }];
    expect(
      await run(SortNode, kind, { sortFields: [{ field: "n" }] }, { value: items })
    ).toEqual({ result: [{ n: 1 }, { n: 2 }, { n: 3 }] });

    expect(
      await run(
        SortNode,
        kind,
        { sortFields: [{ field: "n", direction: "desc" }] },
        { value: items }
      )
    ).toEqual({ result: [{ n: 3 }, { n: 2 }, { n: 1 }] });
  });

  it("supports string comparison and nested dot-notation paths", async () => {
    const strings = await run(
      SortNode,
      kind,
      { sortFields: [{ field: "n" }], valueType: "string" },
      { value: [{ n: "10" }, { n: "2" }, { n: "1" }] }
    );
    expect(strings.result).toEqual([{ n: "1" }, { n: "10" }, { n: "2" }]);

    const nested = await run(
      SortNode,
      kind,
      { sortFields: [{ field: "meta.rank" }] },
      { value: [{ meta: { rank: 2 } }, { meta: { rank: 1 } }] }
    );
    expect(nested.result).toEqual([{ meta: { rank: 1 } }, { meta: { rank: 2 } }]);
  });

  it("preserves input order without fields and returns [] for nil input (R7)", async () => {
    expect(
      await run(SortNode, kind, {}, { value: [{ n: 2 }, { n: 1 }] })
    ).toEqual({ result: [{ n: 2 }, { n: 1 }] });
    expect(await run(SortNode, kind, {}, {})).toEqual({ result: [] });
  });
});

describe("core.data.renameKeys", () => {
  const kind = "core.data.renameKeys";

  it("renames top-level and dotted nested keys", async () => {
    const result = await run(
      RenameKeysNode,
      kind,
      {
        renames: [
          { from: "first_name", to: "name" },
          { from: "nested.old", to: "nested.new" },
        ],
      },
      { value: { first_name: "Ada", nested: { old: 1 } } }
    );
    expect(result.result).toEqual({ name: "Ada", nested: { new: 1 } });
  });

  it("maps arrays of records (R6)", async () => {
    const result = await run(
      RenameKeysNode,
      kind,
      { renames: [{ from: "a", to: "b" }] },
      { value: [{ a: 1 }, { a: 2 }] }
    );
    expect(result.result).toEqual([{ b: 1 }, { b: 2 }]);
  });

  it("passes non-record values through and returns [] for nil input (R7)", async () => {
    expect(
      await run(RenameKeysNode, kind, { renames: [{ from: "a", to: "b" }] }, { value: [1, 2] })
    ).toEqual({ result: [1, 2] });
    expect(await run(RenameKeysNode, kind, {}, {})).toEqual({ result: [] });
  });
});
