/**
 * @module as-graph/nodes/data/summarize
 * @description Groups items by zero or more split fields and applies the
 * configured aggregations (count, sum, average, min, max, unique count,
 * append, concatenate). Results are emitted either as one item per group or as
 * a single nested record. The aggregation engine is shared with the Item
 * Lists node through `transform-utils`.
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
import { asGraphDataArray } from "../support";
import {
  prepareGraphFields,
  summarizeGraphItems,
  type SummarizeField,
} from "../transform-utils";

/** Whether summarized groups become separate items or one nested record. */
export type SummarizeOutputFormat = "separateItems" | "singleItem";

/** Inputs accepted by the Summarize node; `value` carries the item collection. */
export type SummarizeNodeInput = Record<string, unknown>;

/** Outputs produced by the Summarize node. */
export interface SummarizeNodeOutput {
  /** Summary records, one per group (or a single record for `singleItem`). */
  result: Record<string, unknown>[];
}

/**
 * Summarize node (`core.data.summarize`): groups items by split fields and
 * applies count/sum/average/min/max/unique/append/concatenate aggregations.
 */
@node("core.data.summarize", {
  kind: "core.data.summarize",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-chart-dots",
  width: 96,
  height: 96,
  labels: ["data", "summarize", "pivot", "aggregate"],
  metadata: {
    title: "graph.node.data.summarize.name",
    description: "graph.node.data.summarize.description",
  },
})
@model()
export class SummarizeNode extends GraphNode<
  SummarizeNodeInput,
  SummarizeNodeOutput
> {
  /**
   * Summarizes the input items.
   *
   * @param request - Execution request; `inputs.value` holds the item collection.
   * @returns Execution values with the summarized `result` records.
   * @throws {GraphExecutionError} `GRAPH_SUMMARIZE_FIELDS_REQUIRED` when no
   *   aggregation is configured, or `GRAPH_SUMMARIZE_FIELD_NOT_FOUND` when a
   *   referenced field is absent and `continueIfFieldNotFound` is false.
   */
  override execute(
    request: GraphNodeExecutionRequest<SummarizeNodeInput>
  ): GraphExecutionValues {
    const items = asGraphDataArray(request.inputs["value"]);
    const fields = (this.fieldsToSummarize ?? []).filter(
      (entry) => entry && typeof entry.aggregation === "string"
    );
    if (fields.length === 0) {
      throw new GraphExecutionError(
        "Summarize node requires at least one field to summarize",
        "GRAPH_SUMMARIZE_FIELDS_REQUIRED"
      );
    }
    return {
      result: summarizeGraphItems(items, fields, {
        fieldsToSplitBy: prepareGraphFields(
          this.fieldsToSplitBy,
          "Fields To Split By"
        ),
        outputFormat: this.outputFormat,
        skipEmptySplitFields: this.skipEmptySplitFields === true,
        dotNotation: this.disableDotNotation !== true,
        continueIfFieldNotFound: this.continueIfFieldNotFound === true,
      }),
    };
  }

  /** Items to summarize (array, single item, or nil). */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Aggregations to compute for every group. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.summarize.fields.fieldsToSummarize.label",
    placeholder:
      "graph.node.data.summarize.fields.fieldsToSummarize.placeholder",
    type: "collection",
  })
  @input({ handle: "fieldsToSummarize", userControlled: true, type: "array" })
  fieldsToSummarize?: SummarizeField[] = [];

  /** Grouping fields; an empty list summarizes all items as one group. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.summarize.fields.fieldsToSplitBy.label",
    placeholder: "graph.node.data.summarize.fields.fieldsToSplitBy.placeholder",
    type: "text",
  })
  @input({ handle: "fieldsToSplitBy", userControlled: true })
  fieldsToSplitBy?: string | string[];

  /** Emit one item per group or one nested record (default `separateItems`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.summarize.fields.outputFormat.label",
    type: "select",
  })
  @input({ handle: "outputFormat", userControlled: true })
  outputFormat: SummarizeOutputFormat = "separateItems";

  /** Skip items whose split fields are empty (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.summarize.fields.skipEmptySplitFields.label",
    type: "checkbox",
  })
  @input({ handle: "skipEmptySplitFields", userControlled: true })
  skipEmptySplitFields?: boolean = false;

  /** Treat field names literally instead of as dot-separated paths (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.summarize.fields.disableDotNotation.label",
    type: "checkbox",
  })
  @input({ handle: "disableDotNotation", userControlled: true })
  disableDotNotation?: boolean = false;

  /** Summarize a missing field as empty instead of failing (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.summarize.fields.continueIfFieldNotFound.label",
    type: "checkbox",
  })
  @input({ handle: "continueIfFieldNotFound", userControlled: true })
  continueIfFieldNotFound?: boolean = false;

  /** Summary records. */
  @required()
  @output({ handle: "result" })
  result!: Record<string, unknown>[];
}
