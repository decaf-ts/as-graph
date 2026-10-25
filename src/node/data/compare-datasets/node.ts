/**
 * @module as-graph/nodes/data/compare-datasets
 * @description Compares two datasets (`input` and `input2`) on one or more
 * field pairs and splits the results into four outputs: `onlyInA`, `same`,
 * `different`, and `onlyInB`. Matching supports exact or fuzzy value
 * comparison, first/all multiple matches, and per-mode conflict resolution
 * (`preferInput1`, `preferInput2`, `mix`, or `includeBoth`).
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { asGraphDataArray, getGraphDataValue, isGraphDataRecord } from "../support";
import {
  graphValueEquals,
  graphValuesLooselyEqual,
  omitGraphFields,
  prepareGraphFields,
} from "../transform-utils";

/** A pair of field names to match across the two datasets (`field1`/`field2` or their `fieldA`/`fieldB` aliases). */
export interface CompareFieldPair {
  field1?: string;
  field2?: string;
  fieldA?: string;
  fieldB?: string;
}

/** How a matched pair with differing values is emitted: keep input 1, input 2, a mixed record, or both sides. */
export type CompareResolve =
  | "preferInput1"
  | "preferInput2"
  | "mix"
  | "includeBoth";

/** Whether a left item matches only the first or every right item sharing the match fields. */
export type CompareMultipleMatches = "first" | "all";

/** Inputs accepted by the Compare Datasets node: `input` (A) and `input2` (B). */
export type CompareDatasetsNodeInput = Record<string, unknown>;

  /** Items present only in the second dataset. */
  /** Matched items with differing values, shaped by the configured resolution mode. */
  /** Matched items whose remaining comparable fields are equal. */
  /** Items present only in the first dataset. */
/** Outputs produced by the Compare Datasets node. */
export interface CompareDatasetsNodeOutput {
  onlyInA: unknown[];
  same: unknown[];
  different: unknown[];
  onlyInB: unknown[];
}

function pairFields(pair: CompareFieldPair): { a: string; b: string } | undefined {
  const a = pair?.field1 ?? pair?.fieldA;
  const b = pair?.field2 ?? pair?.fieldB;
  if (!a || !b) return undefined;
  return { a, b };
}

function recordFields(value: unknown): string[] {
  return isGraphDataRecord(value) ? Object.keys(value) : [];
}

function includeBothRecord(
  left: unknown,
  right: unknown,
  pairs: { a: string; b: string }[],
  options: {
    skipFields: string[];
    dotNotation: boolean;
    equals: (left: unknown, right: unknown) => boolean;
  }
): Record<string, unknown> {
  const leftRecord = isGraphDataRecord(left) ? left : { value: left };
  const rightRecord = isGraphDataRecord(right) ? right : { value: right };
  const keys: Record<string, unknown> = {};
  for (const pair of pairs) {
    keys[pair.a] = getGraphDataValue(leftRecord, pair.a, options.dotNotation);
  }
  const allKeys = Array.from(
    new Set([...recordFields(leftRecord), ...recordFields(rightRecord)])
  );
  const same: Record<string, unknown> = {};
  const different: Record<string, unknown> = {};
  for (const key of allKeys) {
    if (options.skipFields.includes(key)) continue;
    const leftValue = getGraphDataValue(leftRecord, key, options.dotNotation);
    const rightValue = getGraphDataValue(rightRecord, key, options.dotNotation);
    if (options.equals(leftValue, rightValue)) {
      same[key] = leftValue;
    } else {
      different[key] = { inputA: leftValue, inputB: rightValue };
    }
  }
  return { keys, same, different };
}

/**
 * Compare Datasets node (`core.data.compareDatasets`): matches two item
 * collections on field pairs and emits only-in-A, same, different, and
 * only-in-B partitions.
 */
@node("core.data.compareDatasets", {
  kind: "core.data.compareDatasets",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-git-compare",
  width: 96,
  height: 96,
  labels: ["data", "compare", "diff", "datasets"],
  metadata: {
    title: "graph.node.data.compare_datasets.name",
    description: "graph.node.data.compare_datasets.description",
  },
})
@model()
export class CompareDatasetsNode extends GraphNode<
  CompareDatasetsNodeInput,
  CompareDatasetsNodeOutput
> {
  /**
   * Compares the two input datasets.
   *
   * @param request - Execution request; `inputs.input` and `inputs.input2`
   *   hold the datasets to compare.
   * @returns Execution values with `onlyInA`, `same`, `different`, and
   *   `onlyInB` partitions.
   * @throws {GraphExecutionError} `GRAPH_COMPARE_DATASETS_MATCH_FIELDS_REQUIRED`
   *   when no complete field pair is configured.
   */
  override execute(
    request: GraphNodeExecutionRequest<CompareDatasetsNodeInput>
  ): GraphExecutionValues {
    const pairs = (this.fieldsToMatch ?? [])
      .map(pairFields)
      .filter((pair): pair is { a: string; b: string } => pair !== undefined);
    if (pairs.length === 0) {
      throw new GraphExecutionError(
        "Compare Datasets node requires at least one pair of fields to match on",
        "GRAPH_COMPARE_DATASETS_MATCH_FIELDS_REQUIRED"
      );
    }

    const dotNotation = this.disableDotNotation !== true;
    const equals = this.fuzzyCompare
      ? graphValuesLooselyEqual
      : graphValueEquals;
    const skipFields = prepareGraphFields(this.skipFields, "Fields to Skip");
    const exceptFields = prepareGraphFields(
      this.exceptWhenMix,
      "For Everything Except"
    );
    const left = asGraphDataArray(request.inputs["input"]);
    const right = asGraphDataArray(request.inputs["input2"]);
    const multipleMatches = this.multipleMatches === "all" ? "all" : "first";
    const resolve = this.resolve ?? "includeBoth";

    const onlyInA: unknown[] = [];
    const same: unknown[] = [];
    const different: unknown[] = [];
    const onlyInB: unknown[] = [];
    const matchedRight = new Set<number>();

    for (const leftItem of left) {
      const lookup = pairs.map((pair) => ({
        field: pair.b,
        value: getGraphDataValue(leftItem, pair.a, dotNotation),
      }));
      if (lookup.some((entry) => entry.value === undefined)) {
        onlyInA.push(leftItem);
        continue;
      }

      const matches: { item: unknown; index: number }[] = [];
      for (let index = 0; index < right.length; index++) {
        const rightItem = right[index];
        const isMatch = pairs.every((pair) =>
          equals(
            getGraphDataValue(leftItem, pair.a, dotNotation),
            getGraphDataValue(rightItem, pair.b, dotNotation)
          )
        );
        if (!isMatch) continue;
        matches.push({ item: rightItem, index });
        if (multipleMatches === "first") break;
      }

      if (matches.length === 0) {
        onlyInA.push(leftItem);
        continue;
      }

      let sameRecord: unknown;
      for (const match of matches) {
        matchedRight.add(match.index);
        const leftComparable = omitGraphFields(
          leftItem,
          skipFields,
          dotNotation
        );
        const rightComparable = omitGraphFields(
          match.item,
          skipFields,
          dotNotation
        );
        if (equals(leftComparable, rightComparable)) {
          if (sameRecord === undefined) {
            sameRecord =
              this.fuzzyCompare && resolve === "preferInput2"
                ? match.item
                : leftItem;
          }
          continue;
        }
        switch (resolve) {
          case "preferInput1":
            different.push(leftItem);
            break;
          case "preferInput2":
            different.push(match.item);
            break;
          case "mix": {
            const preferred =
              this.preferWhenMix === "input2" ? match.item : leftItem;
            const other =
              this.preferWhenMix === "input2" ? leftItem : match.item;
            if (exceptFields.length === 0) {
              different.push(preferred);
              break;
            }
            const merged: Record<string, unknown> = isGraphDataRecord(preferred)
              ? { ...preferred }
              : { value: preferred };
            const source = isGraphDataRecord(other) ? other : { value: other };
            for (const field of exceptFields) {
              const value = getGraphDataValue(source, field, dotNotation);
              if (!dotNotation) {
                merged[field] = value;
                continue;
              }
              const segments = field.split(".").filter(Boolean);
              let cursor: Record<string, unknown> = merged;
              for (let index = 0; index < segments.length - 1; index++) {
                const next = cursor[segments[index]];
                if (isGraphDataRecord(next)) {
                  cursor = next;
                } else {
                  const created: Record<string, unknown> = {};
                  cursor[segments[index]] = created;
                  cursor = created;
                }
              }
              cursor[segments[segments.length - 1]] = value;
            }
            different.push(merged);
            break;
          }
          case "includeBoth":
          default:
            different.push(
              includeBothRecord(leftItem, match.item, pairs, {
                skipFields,
                dotNotation,
                equals,
              })
            );
            break;
        }
      }
      if (sameRecord !== undefined) same.push(sameRecord);
    }

    right.forEach((item, index) => {
      if (!matchedRight.has(index)) onlyInB.push(item);
    });

    return { onlyInA, same, different, onlyInB };
  }

  /** First dataset (input A). */
  @required()
  @input({ handle: "input" })
  input!: unknown;

  /** Second dataset (input B). */
  @required()
  @input({ handle: "input2" })
  input2!: unknown;

  /** Field pairs used to decide whether two items refer to the same record. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.compare_datasets.fields.fieldsToMatch.label",
    placeholder:
      "graph.node.data.compare_datasets.fields.fieldsToMatch.placeholder",
    type: "collection",
  })
  @input({ handle: "fieldsToMatch", userControlled: true, type: "array" })
  fieldsToMatch?: CompareFieldPair[] = [];

  /** Emission strategy for matched items with differing values (default `includeBoth`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.compare_datasets.fields.resolve.label",
    type: "select",
  })
  @input({ handle: "resolve", userControlled: true })
  resolve: CompareResolve = "includeBoth";

  /** Whether each left item may match one or every right item (default `first`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.compare_datasets.fields.multipleMatches.label",
    type: "select",
  })
  @input({ handle: "multipleMatches", userControlled: true })
  multipleMatches: CompareMultipleMatches = "first";

  /** Compare loosely (numeric strings, JSON strings, and empty values) instead of strictly (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.compare_datasets.fields.fuzzyCompare.label",
    type: "checkbox",
  })
  @input({ handle: "fuzzyCompare", userControlled: true })
  fuzzyCompare?: boolean = false;

  /** Preferred side for `mix` resolution (default `input1`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.compare_datasets.fields.preferWhenMix.label",
    type: "select",
  })
  @input({ handle: "preferWhenMix", userControlled: true })
  preferWhenMix: "input1" | "input2" = "input1";

  /** Fields copied from the other side when resolving with `mix`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.compare_datasets.fields.exceptWhenMix.label",
    placeholder:
      "graph.node.data.compare_datasets.fields.exceptWhenMix.placeholder",
    type: "text",
  })
  @input({ handle: "exceptWhenMix", userControlled: true })
  exceptWhenMix?: string | string[];

  /** Fields ignored when deciding whether matched items are `same` or `different`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.compare_datasets.fields.skipFields.label",
    placeholder:
      "graph.node.data.compare_datasets.fields.skipFields.placeholder",
    type: "text",
  })
  @input({ handle: "skipFields", userControlled: true })
  skipFields?: string | string[];

  /** Treat field names literally instead of as dot-separated paths (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.compare_datasets.fields.disableDotNotation.label",
    type: "checkbox",
  })
  @input({ handle: "disableDotNotation", userControlled: true })
  disableDotNotation?: boolean = false;

  /** Items present only in input A. */
  @required()
  @output({ handle: "onlyInA" })
  onlyInA!: unknown[];

  /** Matched items judged equal. */
  @output({ handle: "same" })
  same!: unknown[];

  /** Matched items judged different. */
  @output({ handle: "different" })
  different!: unknown[];

  /** Items present only in input B. */
  @output({ handle: "onlyInB" })
  onlyInB!: unknown[];
}
