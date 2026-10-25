/**
 * @module as-graph/tests/unit/graph/nodes/Stage5aDataTransforms.test
 * @summary Unit coverage for the SAA-1448 Stage 5a data transform kinds.
 * @description Drives the instance `execute` contract of `core.data.aggregate`,
 * `core.data.itemLists`, `core.data.compareDatasets`, `core.data.summarize`,
 * and `core.data.removeDuplicates` through the production
 * `instantiate(graphNodeConfig(...))` path: per-kind success shapes, the
 * documented mode/option combinations, and the documented
 * `GraphExecutionError` failure codes.
 */
import { describe, it, expect } from "@jest/globals";

import {
  AggregateNode,
  CompareDatasetsNode,
  ItemListsNode,
  RemoveDuplicatesNode,
  SummarizeNode,
} from "../../../../src/node";
import type { GraphNodeClass } from "../../../../src/node/base";
import type { GraphExecutionValues } from "../../../../src/engine/types";
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

describe("core.data.aggregate", () => {
  const kind = "core.data.aggregate";

  it("collects values per item, resolving dotted paths into the leaf field", async () => {
    const result = await run(
      AggregateNode,
      kind,
      {
        fieldsToAggregate: [{ field: "id" }, { field: "address.city" }],
      },
      {
        value: [
          { id: 1, address: { city: "London" } },
          { id: 2, address: { city: "Paris" } },
        ],
      }
    );
    expect(result).toEqual({
      result: { id: [1, 2], city: ["London", "Paris"] },
    });
  });

  it("honours outputFieldName and flattens list values when mergeLists is set", async () => {
    const result = await run(
      AggregateNode,
      kind,
      {
        mergeLists: true,
        fieldsToAggregate: [
          { field: "tags", outputFieldName: "allTags" },
          { field: "id" },
        ],
      },
      {
        value: [
          { id: 1, tags: ["x", "y"] },
          { id: 2, tags: ["z"] },
        ],
      }
    );
    expect(result.result).toEqual({ allTags: ["x", "y", "z"], id: [1, 2] });
  });

  it("keeps undefined values for items that do not carry the field when keepMissing is set", async () => {
    const result = await run(
      AggregateNode,
      kind,
      { keepMissing: true, fieldsToAggregate: [{ field: "tags" }] },
      { value: [{ tags: ["x"] }, {}] }
    );
    expect(result.result).toEqual({ tags: [["x"], undefined] });
  });

  it("rejects two aggregate fields that resolve to the same output name", async () => {
    await expect(
      run(
        AggregateNode,
        kind,
        {
          fieldsToAggregate: [{ field: "name" }, { field: "user.name" }],
        },
        { value: [{ name: "a", user: { name: "b" } }] }
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_AGGREGATE_DUPLICATE_FIELD" });
  });

  it("requires at least one field to aggregate", async () => {
    await expect(
      run(AggregateNode, kind, {}, { value: [{ id: 1 }] })
    ).rejects.toMatchObject({ graphCode: "GRAPH_AGGREGATE_FIELDS_REQUIRED" });
  });

  it("aggregates whole item data under the destination field with allFields", async () => {
    const result = await run(
      AggregateNode,
      kind,
      { aggregate: "aggregateAllItemData", destinationFieldName: "rows" },
      { value: [{ a: 1, b: 2 }, { a: 3, c: 4 }] }
    );
    expect(result).toEqual({ result: { rows: [{ a: 1, b: 2 }, { a: 3, c: 4 }] } });
  });

  it("aggregates only specified or non-excluded item fields in whole-item mode", async () => {
    const specified = await run(
      AggregateNode,
      kind,
      {
        aggregate: "aggregateAllItemData",
        include: "specifiedFields",
        fieldsToInclude: "a,b",
      },
      { value: [{ a: 1, b: 2 }, { a: 3, c: 4 }] }
    );
    expect(specified.result).toEqual({ data: [{ a: 1, b: 2 }, { a: 3 }] });

    const except = await run(
      AggregateNode,
      kind,
      {
        aggregate: "aggregateAllItemData",
        include: "allFieldsExcept",
        fieldsToExclude: ["b"],
      },
      { value: [{ a: 1, b: 2 }, { a: 3, c: 4 }] }
    );
    expect(except.result).toEqual({ data: [{ a: 1 }, { a: 3, c: 4 }] });
  });
});

describe("core.data.itemLists", () => {
  const kind = "core.data.itemLists";

  it("concatenates fields with the same individual-fields semantics as Aggregate", async () => {
    const result = await run(
      ItemListsNode,
      kind,
      { fieldsToAggregate: [{ field: "id" }, { field: "name" }] },
      { value: [{ id: 1, name: "a" }, { id: 2, name: "b" }] }
    );
    expect(result).toEqual({ result: { id: [1, 2], name: ["a", "b"] } });
  });

  it("concatenates whole item data into the configured destination field", async () => {
    const result = await run(
      ItemListsNode,
      kind,
      {
        aggregate: "aggregateAllItemData",
        destinationFieldName: "people",
      },
      { value: [{ id: 1 }, { id: 2 }] }
    );
    expect(result.result).toEqual({ people: [{ id: 1 }, { id: 2 }] });
  });

  it("limits to the first or last N items", async () => {
    expect(
      (await run(ItemListsNode, kind, { operation: "limit", maxItems: 2 }, { value: [1, 2, 3, 4] }))
        .result
    ).toEqual([1, 2]);

    expect(
      (
        await run(
          ItemListsNode,
          kind,
          { operation: "limit", maxItems: 2, keep: "lastItems" },
          { value: [1, 2, 3, 4] }
        )
      ).result
    ).toEqual([3, 4]);
  });

  it("removes duplicates and reports the discarded items", async () => {
    const result = await run(
      ItemListsNode,
      kind,
      { operation: "removeDuplicates" },
      { value: [{ a: 1 }, { a: 1 }, { a: 2 }] }
    );
    expect(result.result).toEqual([{ a: 1 }, { a: 2 }]);
    expect(result.discarded).toEqual([{ a: 1 }]);
  });

  it("sorts by the configured field and direction", async () => {
    expect(
      (
        await run(
          ItemListsNode,
          kind,
          { operation: "sort", sortFields: [{ field: "n", direction: "desc" }] },
          { value: [{ n: 1 }, { n: 3 }, { n: 2 }] }
        )
      ).result
    ).toEqual([{ n: 3 }, { n: 2 }, { n: 1 }]);
  });

  it("splits out an array field with and without the surrounding fields", async () => {
    expect(
      (
        await run(
          ItemListsNode,
          kind,
          {
            operation: "splitOutItems",
            field: "tags",
            splitOutInclude: "allOtherFields",
            destinationField: "tag",
          },
          { value: [{ id: 1, tags: ["x", "y"] }, { id: 2, tags: [] }] }
        )
      ).result
    ).toEqual([
      { id: 1, tag: "x" },
      { id: 1, tag: "y" },
    ]);

    expect(
      (
        await run(
          ItemListsNode,
          kind,
          { operation: "splitOutItems", field: "tags" },
          { value: [{ id: 1, tags: ["x", "y"] }] }
        )
      ).result
    ).toEqual(["x", "y"]);
  });

  it("runs the summarize operation inline", async () => {
    const result = await run(
      ItemListsNode,
      kind,
      {
        operation: "summarize",
        fieldsToSummarize: [{ aggregation: "sum", field: "amount" }],
        fieldsToSplitBy: "g",
      },
      {
        value: [
          { g: "a", amount: 10 },
          { g: "a", amount: 20 },
          { g: "b", amount: 5 },
        ],
      }
    );
    expect(result.result).toEqual([
      { sum_amount: 30, g: "a" },
      { sum_amount: 5, g: "b" },
    ]);
  });

  it("fails on unsupported operations, missing split fields, and missing summarize fields", async () => {
    await expect(
      run(ItemListsNode, kind, { operation: "bogus" }, { value: [1] })
    ).rejects.toMatchObject({ graphCode: "GRAPH_ITEM_LISTS_UNSUPPORTED_OPERATION" });

    await expect(
      run(
        ItemListsNode,
        kind,
        { operation: "splitOutItems" },
        { value: [{ id: 1 }] }
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_ITEM_LISTS_FIELD_REQUIRED" });

    await expect(
      run(
        ItemListsNode,
        kind,
        { operation: "summarize", fieldsToSummarize: [] },
        { value: [{ id: 1 }] }
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_SUMMARIZE_FIELDS_REQUIRED" });

    await expect(
      run(ItemListsNode, kind, { fieldsToAggregate: [] }, { value: [{ id: 1 }] })
    ).rejects.toMatchObject({ graphCode: "GRAPH_AGGREGATE_FIELDS_REQUIRED" });
  });
});

describe("core.data.compareDatasets", () => {
  const kind = "core.data.compareDatasets";
  const left = [
    { id: 1, name: "a" },
    { id: 2, name: "b" },
  ];
  const right = [
    { id: 1, name: "z" },
    { id: 3, name: "c" },
  ];
  const match = { fieldsToMatch: [{ field1: "id", field2: "id" }] };

  it("splits two inputs into onlyInA, same, different, and onlyInB", async () => {
    const identical = await run(
      CompareDatasetsNode,
      kind,
      match,
      {
        input: [{ id: 1, name: "a" }],
        input2: [{ id: 1, name: "a" }],
      }
    );
    expect(identical).toEqual({
      onlyInA: [],
      same: [{ id: 1, name: "a" }],
      different: [],
      onlyInB: [],
    });

    const result = await run(CompareDatasetsNode, kind, match, {
      input: left,
      input2: right,
    });
    expect(result.onlyInA).toEqual([{ id: 2, name: "b" }]);
    expect(result.onlyInB).toEqual([{ id: 3, name: "c" }]);
    expect(result.same).toEqual([]);
    expect(result.different).toEqual([
      {
        keys: { id: 1 },
        same: { id: 1 },
        different: { name: { inputA: "a", inputB: "z" } },
      },
    ]);
  });

  it("resolves differing matches with preferInput1 and preferInput2", async () => {
    const preferFirst = await run(
      CompareDatasetsNode,
      kind,
      { ...match, resolve: "preferInput1" },
      { input: left, input2: right }
    );
    expect(preferFirst.different).toEqual([{ id: 1, name: "a" }]);

    const preferSecond = await run(
      CompareDatasetsNode,
      kind,
      { ...match, resolve: "preferInput2" },
      { input: left, input2: right }
    );
    expect(preferSecond.different).toEqual([{ id: 1, name: "z" }]);
  });

  it("resolves differing matches with mix, copying exceptWhenMix fields from the other input", async () => {
    const mixFirst = await run(
      CompareDatasetsNode,
      kind,
      { ...match, resolve: "mix", exceptWhenMix: ["name"] },
      { input: left, input2: right }
    );
    expect(mixFirst.different).toEqual([{ id: 1, name: "z" }]);

    const mixSecond = await run(
      CompareDatasetsNode,
      kind,
      {
        ...match,
        resolve: "mix",
        preferWhenMix: "input2",
        exceptWhenMix: ["name"],
      },
      { input: left, input2: right }
    );
    expect(mixSecond.different).toEqual([{ id: 1, name: "a" }]);
  });

  it("honours multipleMatches first and all", async () => {
    const first = await run(
      CompareDatasetsNode,
      kind,
      { ...match, multipleMatches: "first" },
      {
        input: [{ id: 1, name: "x" }],
        input2: [
          { id: 1, name: "x" },
          { id: 1, name: "x" },
        ],
      }
    );
    expect(first.same).toHaveLength(1);
    expect(first.onlyInB).toHaveLength(1);

    const all = await run(
      CompareDatasetsNode,
      kind,
      { ...match, multipleMatches: "all" },
      {
        input: [{ id: 1, name: "x" }],
        input2: [
          { id: 1, name: "x" },
          { id: 1, name: "x" },
        ],
      }
    );
    expect(all.same).toHaveLength(1);
    expect(all.onlyInB).toHaveLength(0);
  });

  it("matches across value types when fuzzyCompare is enabled", async () => {
    const strict = await run(CompareDatasetsNode, kind, match, {
      input: [{ id: 1, name: "x" }],
      input2: [{ id: "1", name: "x" }],
    });
    expect(strict.onlyInA).toHaveLength(1);
    expect(strict.onlyInB).toHaveLength(1);

    const fuzzy = await run(CompareDatasetsNode, kind, { ...match, fuzzyCompare: true }, {
      input: [{ id: 1, name: "x" }],
      input2: [{ id: "1", name: "x" }],
    });
    expect(fuzzy.onlyInA).toHaveLength(0);
    expect(fuzzy.onlyInB).toHaveLength(0);
    expect(fuzzy.different).toHaveLength(1);
  });

  it("ignores configured skipFields when deciding whether a match is identical", async () => {
    const result = await run(
      CompareDatasetsNode,
      kind,
      { ...match, skipFields: ["ignored"] },
      {
        input: [{ id: 1, v: "a", ignored: "x" }],
        input2: [{ id: 1, v: "a", ignored: "y" }],
      }
    );
    expect(result.same).toEqual([{ id: 1, v: "a", ignored: "x" }]);
    expect(result.different).toEqual([]);
  });

  it("requires at least one field pair to match on", async () => {
    await expect(
      run(CompareDatasetsNode, kind, {}, { input: left, input2: right })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_COMPARE_DATASETS_MATCH_FIELDS_REQUIRED",
    });
  });
});

describe("core.data.summarize", () => {
  const kind = "core.data.summarize";
  const items = [
    { g: "a", amount: 10, tag: "x" },
    { g: "a", amount: 20, tag: "x" },
    { g: "b", amount: 5, tag: "y" },
  ];

  it("computes every documented aggregation", async () => {
    const result = await run(
      SummarizeNode,
      kind,
      {
        fieldsToSummarize: [
          { aggregation: "append", field: "amount" },
          { aggregation: "average", field: "amount" },
          { aggregation: "concatenate", field: "amount" },
          { aggregation: "count", field: "amount" },
          { aggregation: "countUnique", field: "tag" },
          { aggregation: "max", field: "amount" },
          { aggregation: "min", field: "amount" },
          { aggregation: "sum", field: "amount" },
        ],
      },
      { value: items }
    );
    expect(result.result).toEqual([
      {
        appended_amount: [10, 20, 5],
        average_amount: 35 / 3,
        concatenated_amount: "10,20,5",
        count_amount: 3,
        unique_count_tag: 2,
        max_amount: 20,
        min_amount: 5,
        sum_amount: 35,
      },
    ]);
  });

  it("splits into separate items per split-field combination", async () => {
    const result = await run(
      SummarizeNode,
      kind,
      {
        fieldsToSummarize: [{ aggregation: "sum", field: "amount" }],
        fieldsToSplitBy: "g",
        outputFormat: "separateItems",
      },
      { value: items }
    );
    expect(result.result).toEqual([
      { sum_amount: 30, g: "a" },
      { sum_amount: 5, g: "b" },
    ]);
  });

  it("collapses split groups into a single item when outputFormat is singleItem", async () => {
    const result = await run(
      SummarizeNode,
      kind,
      {
        fieldsToSummarize: [{ aggregation: "sum", field: "amount" }],
        fieldsToSplitBy: "g",
        outputFormat: "singleItem",
      },
      { value: items }
    );
    expect(result.result).toEqual([
      {
        sum_amount: 35,
        g: {
          a: { sum_amount: 30 },
          b: { sum_amount: 5 },
        },
      },
    ]);
  });

  it("nests every split field per value when outputFormat is singleItem", async () => {
    const result = await run(
      SummarizeNode,
      kind,
      {
        fieldsToSummarize: [{ aggregation: "sum", field: "amount" }],
        fieldsToSplitBy: ["g", "h"],
        outputFormat: "singleItem",
      },
      {
        value: [
          { g: "a", h: "x", amount: 1 },
          { g: "a", h: "y", amount: 2 },
          { g: "a", h: "x", amount: 3 },
          { g: "b", h: "x", amount: 4 },
        ],
      }
    );
    expect(result.result).toEqual([
      {
        sum_amount: 10,
        g: {
          a: {
            h: {
              x: { sum_amount: 4 },
              y: { sum_amount: 2 },
            },
          },
          b: {
            h: {
              x: { sum_amount: 4 },
            },
          },
        },
      },
    ]);
  });

  it("keys singleItem split values by their string form, including numbers", async () => {
    const result = await run(
      SummarizeNode,
      kind,
      {
        fieldsToSummarize: [{ aggregation: "sum", field: "amount" }],
        fieldsToSplitBy: "g",
        outputFormat: "singleItem",
      },
      {
        value: [
          { g: 1, amount: 2 },
          { g: 2, amount: 3 },
          { g: 1, amount: 4 },
        ],
      }
    );
    expect(result.result).toEqual([
      {
        sum_amount: 9,
        g: {
          "1": { sum_amount: 6 },
          "2": { sum_amount: 3 },
        },
      },
    ]);
  });

  it("skips empty split-field values only when skipEmptySplitFields is set", async () => {
    const splitItems = [{ g: "a", amount: 1 }, { amount: 2 }];
    const kept = await run(
      SummarizeNode,
      kind,
      {
        fieldsToSummarize: [{ aggregation: "sum", field: "amount" }],
        fieldsToSplitBy: "g",
        skipEmptySplitFields: true,
      },
      { value: splitItems }
    );
    expect(kept.result).toEqual([{ sum_amount: 1, g: "a" }]);

    const all = await run(
      SummarizeNode,
      kind,
      {
        fieldsToSummarize: [{ aggregation: "sum", field: "amount" }],
        fieldsToSplitBy: "g",
      },
      { value: splitItems }
    );
    expect(all.result).toHaveLength(2);
  });

  it("fails on unknown fields, missing fields, and bypasses with continueIfFieldNotFound", async () => {
    await expect(
      run(
        SummarizeNode,
        kind,
        { fieldsToSummarize: [{ aggregation: "sum", field: "missing" }] },
        { value: items }
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_SUMMARIZE_FIELD_NOT_FOUND" });

    await expect(
      run(SummarizeNode, kind, { fieldsToSummarize: [] }, { value: items })
    ).rejects.toMatchObject({ graphCode: "GRAPH_SUMMARIZE_FIELDS_REQUIRED" });

    expect(
      (
        await run(
          SummarizeNode,
          kind,
          {
            fieldsToSummarize: [{ aggregation: "sum", field: "missing" }],
            continueIfFieldNotFound: true,
          },
          { value: items }
        )
      ).result
    ).toEqual([{ sum_missing: 0 }]);
  });
});

describe("core.data.removeDuplicates", () => {
  const kind = "core.data.removeDuplicates";

  it("compares every field by default and reports discarded items", async () => {
    const result = await run(
      RemoveDuplicatesNode,
      kind,
      {},
      { value: [{ a: 1 }, { a: 1 }, { a: 2 }] }
    );
    expect(result.result).toEqual([{ a: 1 }, { a: 2 }]);
    expect(result.discarded).toEqual([{ a: 1 }]);
  });

  it("compares all fields except the excluded ones", async () => {
    const result = await run(
      RemoveDuplicatesNode,
      kind,
      { compareMode: "allFieldsExcept", fieldsToExclude: ["id"] },
      { value: [{ id: 1, v: "a" }, { id: 2, v: "a" }] }
    );
    expect(result.result).toEqual([{ id: 1, v: "a" }]);
    expect(result.discarded).toEqual([{ id: 2, v: "a" }]);
  });

  it("compares only the selected fields and can project away the other fields", async () => {
    const result = await run(
      RemoveDuplicatesNode,
      kind,
      {
        compareMode: "selectedFields",
        fieldsToCompare: ["id"],
        removeOtherFields: true,
      },
      { value: [{ id: 1, v: "a" }, { id: 1, v: "b" }] }
    );
    expect(result.result).toEqual([{ id: 1 }]);
    expect(result.discarded).toEqual([{ id: 1, v: "b" }]);
  });

  it("fails when the selected fields are absent or the field lists are empty", async () => {
    await expect(
      run(
        RemoveDuplicatesNode,
        kind,
        { compareMode: "selectedFields", fieldsToCompare: ["missing"] },
        { value: [{ id: 1 }] }
      )
    ).rejects.toMatchObject({
      graphCode: "GRAPH_REMOVE_DUPLICATES_FIELD_MISSING",
    });

    await expect(
      run(
        RemoveDuplicatesNode,
        kind,
        { compareMode: "selectedFields" },
        { value: [{ id: 1 }] }
      )
    ).rejects.toMatchObject({
      graphCode: "GRAPH_REMOVE_DUPLICATES_FIELDS_REQUIRED",
    });

    await expect(
      run(
        RemoveDuplicatesNode,
        kind,
        { compareMode: "allFieldsExcept" },
        { value: [{ id: 1 }] }
      )
    ).rejects.toMatchObject({
      graphCode: "GRAPH_REMOVE_DUPLICATES_FIELDS_REQUIRED",
    });
  });
});
