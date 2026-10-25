/**
 * @module as-graph/nodes/data/aggregate
 * @summary Aggregate node declaration (`core.data.aggregate`).
 * @description Aggregates the items of the `value` input either by collecting
 * one output list per configured source field (`aggregateIndividualFields`) or
 * by grouping every item into a single destination field
 * (`aggregateAllItemData`). Field selection honours dot-notation paths,
 * optional list merging, and missing-value handling; the shared aggregation
 * helpers live in `transform-utils`.
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
  aggregateGraphItemData,
  aggregateGraphItems,
  prepareGraphFields,
  type AggregateFieldSpec,
} from "../transform-utils";

/**
 * Aggregation strategy: one output list per configured field, or one
 * destination field holding every aggregated item.
 */
export type AggregateMode =
  | "aggregateIndividualFields"
  | "aggregateAllItemData";

/**
 * Field projection applied by `aggregateAllItemData`: keep every field, keep
 * only the listed fields, or keep every field except the listed ones.
 */
export type AggregateInclude =
  | "allFields"
  | "specifiedFields"
  | "allFieldsExcept";

/** Inputs accepted by the Aggregate node; `value` carries the item collection. */
export type AggregateNodeInput = Record<string, unknown>;

/** Outputs produced by the Aggregate node. */
export interface AggregateNodeOutput {

  /** Aggregated record keyed by output field name (or by `destinationFieldName` for `aggregateAllItemData`). */
  result: Record<string, unknown>;
}

/**
 * Aggregate node (`core.data.aggregate`): collects values from a list of items
 * into per-field arrays or one grouped record.
 */
@node("core.data.aggregate", {
  kind: "core.data.aggregate",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-box-multiple",
  width: 96,
  height: 96,
  labels: ["data", "aggregate", "group"],
  metadata: {
    title: "graph.node.data.aggregate.name",
    description: "graph.node.data.aggregate.description",
  },
})
@model()
export class AggregateNode extends GraphNode<
  AggregateNodeInput,
  AggregateNodeOutput
> {
  /**
   * Aggregates the configured input items.
   *
   * @param request - Execution request; `inputs.value` holds the item collection.
   * @returns Execution values with the aggregated `result` record.
   * @throws {GraphExecutionError} `GRAPH_AGGREGATE_FIELDS_REQUIRED` when
   *   `aggregateIndividualFields` has no usable field specs, or
   *   `GRAPH_AGGREGATE_DUPLICATE_FIELD` when two specs map to the same output.
   */
  override execute(
    request: GraphNodeExecutionRequest<AggregateNodeInput>
  ): GraphExecutionValues {
    const items = asGraphDataArray(request.inputs["value"]);
    if (this.aggregate === "aggregateAllItemData") {
      const destination = this.destinationFieldName || "data";
      return {
        result: {
          [destination]: aggregateGraphItemData(items, {
            include: this.include,
            fieldsToInclude: prepareGraphFields(
              this.fieldsToInclude,
              "Fields To Include"
            ),
            fieldsToExclude: prepareGraphFields(
              this.fieldsToExclude,
              "Fields To Exclude"
            ),
          }),
        },
      };
    }

    const fields = (this.fieldsToAggregate ?? []).filter(
      (entry) => entry && (entry.field || entry.fieldToAggregate)
    );
    if (fields.length === 0) {
      throw new GraphExecutionError(
        "Aggregate node requires at least one field to aggregate",
        "GRAPH_AGGREGATE_FIELDS_REQUIRED"
      );
    }
    return {
      result: aggregateGraphItems(items, fields, {
        dotNotation: this.disableDotNotation !== true,
        mergeLists: this.mergeLists === true,
        keepMissing: this.keepMissing === true,
      }),
    };
  }

  /** Items to aggregate (array, single item, or nil). */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Aggregation strategy (default `aggregateIndividualFields`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.aggregate.fields.aggregate.label",
    type: "select",
  })
  @input({ handle: "aggregate", userControlled: true })
  aggregate: AggregateMode = "aggregateIndividualFields";

  /** Source fields to aggregate, with optional rename/output-name options. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.aggregate.fields.fieldsToAggregate.label",
    placeholder: "graph.node.data.aggregate.fields.fieldsToAggregate.placeholder",
    type: "collection",
  })
  @input({ handle: "fieldsToAggregate", userControlled: true, type: "array" })
  fieldsToAggregate?: AggregateFieldSpec[] = [];

  /** Destination field for `aggregateAllItemData` (default `data`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.aggregate.fields.destinationFieldName.label",
    type: "text",
  })
  @input({ handle: "destinationFieldName", userControlled: true })
  destinationFieldName: string = "data";

  /** Field projection used by `aggregateAllItemData` (default `allFields`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.aggregate.fields.include.label",
    type: "select",
  })
  @input({ handle: "include", userControlled: true })
  include: AggregateInclude = "allFields";

  /** Comma-separated or array field list kept when `include` is `specifiedFields`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.aggregate.fields.fieldsToInclude.label",
    placeholder: "graph.node.data.aggregate.fields.fieldsToInclude.placeholder",
    type: "text",
  })
  @input({ handle: "fieldsToInclude", userControlled: true })
  fieldsToInclude?: string | string[];

  /** Comma-separated or array field list dropped when `include` is `allFieldsExcept`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.aggregate.fields.fieldsToExclude.label",
    placeholder: "graph.node.data.aggregate.fields.fieldsToExclude.placeholder",
    type: "text",
  })
  @input({ handle: "fieldsToExclude", userControlled: true })
  fieldsToExclude?: string | string[];

  /** Flatten array values into a single output list (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.aggregate.fields.mergeLists.label",
    type: "checkbox",
  })
  @input({ handle: "mergeLists", userControlled: true })
  mergeLists?: boolean = false;

  /** Keep `null`/`undefined` values instead of skipping them (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.aggregate.fields.keepMissing.label",
    type: "checkbox",
  })
  @input({ handle: "keepMissing", userControlled: true })
  keepMissing?: boolean = false;

  /** Treat field names literally instead of as dot-separated paths (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.aggregate.fields.disableDotNotation.label",
    type: "checkbox",
  })
  @input({ handle: "disableDotNotation", userControlled: true })
  disableDotNotation?: boolean = false;

  /** Aggregated output record. */
  @required()
  @output({ handle: "result" })
  result!: Record<string, unknown>;
}
