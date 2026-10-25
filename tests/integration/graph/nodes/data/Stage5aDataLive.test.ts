/**
 * @module as-graph/tests/integration/graph/nodes/data/Stage5aDataLive
 * @summary Live integration coverage for the SAA-1448 Stage 5a data kinds.
 * @description Executes the production node classes through the shared
 * `runNode` harness (real instantiation, ctx-bound credential resolver). These
 * kinds are pure in-process transforms, so "live" here means the real node
 * implementation with no mocks and no external service: one success path and
 * one documented failure code per kind.
 */
import { describe, it, expect } from "@jest/globals";
import { AggregateNode } from "../../../../../src/node/data/aggregate/node";
import { CompareDatasetsNode } from "../../../../../src/node/data/compare-datasets/node";
import { ItemListsNode } from "../../../../../src/node/data/item-lists/node";
import { RemoveDuplicatesNode } from "../../../../../src/node/data/remove-duplicates/node";
import { SummarizeNode } from "../../../../../src/node/data/summarize/node";
import { errorCodeOf, runNode } from "../real-service-support";

const LIVE_BACKING = "in-process real node (pure transform; no external service)";

describe(`core.data.aggregate — live node (${LIVE_BACKING})`, () => {
  it("aggregates individual fields across real items", async () => {
    const result = await runNode(
      AggregateNode,
      "core.data.aggregate",
      { fieldsToAggregate: [{ field: "id" }, { field: "name" }] },
      {
        value: [
          { id: 1, name: "Ada" },
          { id: 2, name: "Grace" },
        ],
      }
    );
    expect(result.result).toEqual({ id: [1, 2], name: ["Ada", "Grace"] });
  });

  it("fails when two fields resolve to the same output name", async () => {
    const error = await runNode(
      AggregateNode,
      "core.data.aggregate",
      { fieldsToAggregate: [{ field: "name" }, { field: "user.name" }] },
      { value: [{ name: "a", user: { name: "b" } }] }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_AGGREGATE_DUPLICATE_FIELD");
  });
});

describe(`core.data.itemLists — live node (${LIVE_BACKING})`, () => {
  it("concatenates and limits a real item list", async () => {
    const concatenated = await runNode(
      ItemListsNode,
      "core.data.itemLists",
      { fieldsToAggregate: [{ field: "id" }] },
      { value: [{ id: 1 }, { id: 2 }, { id: 3 }] }
    );
    expect(concatenated.result).toEqual({ id: [1, 2, 3] });

    const limited = await runNode(
      ItemListsNode,
      "core.data.itemLists",
      { operation: "limit", maxItems: 2, keep: "lastItems" },
      { value: [1, 2, 3] }
    );
    expect(limited.result).toEqual([2, 3]);
  });

  it("fails on an unsupported operation", async () => {
    const error = await runNode(
      ItemListsNode,
      "core.data.itemLists",
      { operation: "not-an-operation" },
      { value: [1] }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_ITEM_LISTS_UNSUPPORTED_OPERATION");
  });
});

describe(`core.data.compareDatasets — live node (${LIVE_BACKING})`, () => {
  it("classifies matched and unmatched records from two real inputs", async () => {
    const result = await runNode(
      CompareDatasetsNode,
      "core.data.compareDatasets",
      { fieldsToMatch: [{ field1: "id", field2: "id" }], resolve: "preferInput1" },
      {
        input: [
          { id: 1, name: "a" },
          { id: 2, name: "b" },
        ],
        input2: [
          { id: 1, name: "z" },
          { id: 3, name: "c" },
        ],
      }
    );
    expect(result.onlyInA).toEqual([{ id: 2, name: "b" }]);
    expect(result.onlyInB).toEqual([{ id: 3, name: "c" }]);
    expect(result.different).toEqual([{ id: 1, name: "a" }]);
    expect(result.same).toEqual([]);
  });

  it("fails without a field pair to match on", async () => {
    const error = await runNode(
      CompareDatasetsNode,
      "core.data.compareDatasets",
      {},
      { input: [{ id: 1 }], input2: [{ id: 1 }] }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe(
      "GRAPH_COMPARE_DATASETS_MATCH_FIELDS_REQUIRED"
    );
  });
});

describe(`core.data.summarize — live node (${LIVE_BACKING})`, () => {
  it("sums real items split by a real field", async () => {
    const result = await runNode(
      SummarizeNode,
      "core.data.summarize",
      {
        fieldsToSummarize: [{ aggregation: "sum", field: "amount" }],
        fieldsToSplitBy: "region",
      },
      {
        value: [
          { region: "eu", amount: 10 },
          { region: "eu", amount: 5 },
          { region: "us", amount: 7 },
        ],
      }
    );
    expect(result.result).toEqual([
      { sum_amount: 15, region: "eu" },
      { sum_amount: 7, region: "us" },
    ]);
  });

  it("fails when a requested field is absent", async () => {
    const error = await runNode(
      SummarizeNode,
      "core.data.summarize",
      { fieldsToSummarize: [{ aggregation: "sum", field: "missing" }] },
      { value: [{ amount: 1 }] }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_SUMMARIZE_FIELD_NOT_FOUND");
  });
});

describe(`core.data.removeDuplicates — live node (${LIVE_BACKING})`, () => {
  it("dedupes on selected fields and reports the discarded records", async () => {
    const result = await runNode(
      RemoveDuplicatesNode,
      "core.data.removeDuplicates",
      { compareMode: "selectedFields", fieldsToCompare: ["id"] },
      { value: [{ id: 1, v: "a" }, { id: 1, v: "b" }, { id: 2, v: "c" }] }
    );
    expect(result.result).toEqual([
      { id: 1, v: "a" },
      { id: 2, v: "c" },
    ]);
    expect(result.discarded).toEqual([{ id: 1, v: "b" }]);
  });

  it("fails when the selected field list is empty", async () => {
    const error = await runNode(
      RemoveDuplicatesNode,
      "core.data.removeDuplicates",
      { compareMode: "selectedFields" },
      { value: [{ id: 1 }] }
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe(
      "GRAPH_REMOVE_DUPLICATES_FIELDS_REQUIRED"
    );
  });
});
