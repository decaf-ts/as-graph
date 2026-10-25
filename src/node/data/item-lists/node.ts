/**
 * @module as-graph/nodes/data/item-lists
 * @summary Item Lists node declaration (`core.data.itemLists`).
 * @description One node covering the n8n Item Lists operations: concatenate
 * items into per-field lists (or one grouped record), limit the list, remove
 * duplicates, sort, split an array-valued field into separate items, and
 * summarize items by aggregation. The operation-specific helpers are shared
 * with the dedicated Aggregate, Remove Duplicates, and Summarize nodes through
 * `transform-utils`.
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
  dedupeGraphItems,
  prepareGraphFields,
  sortGraphItems,
  splitGraphOutItems,
  summarizeGraphItems,
  type AggregateFieldSpec,
  type CompareMode,
  type SortSpec,
  type SummarizeField,
} from "../transform-utils";

/** Item-list operation performed by the node. */
export type ItemListsOperation =
  | "concatenateItems"
  | "limit"
  | "removeDuplicates"
  | "sort"
  | "splitOutItems"
  | "summarize";

/** Concatenation strategy: one output list per field, or one destination field holding every item. */
export type ItemListsAggregateMode =
  | "aggregateIndividualFields"
  | "aggregateAllItemData";

/** Field projection applied when concatenating all item data. */
export type ItemListsInclude =
  | "allFields"
  | "specifiedFields"
  | "allFieldsExcept";

/** Inputs accepted by the Item Lists node; `value` carries the item collection. */
export type ItemListsNodeInput = Record<string, unknown>;

/** Outputs produced by the Item Lists node. */
export interface ItemListsNodeOutput {
  /** Operation result (an array for most operations, a record for concatenation). */
  result: unknown;

  /** Items removed by `removeDuplicates` only. */
  discarded?: unknown[];
}

/**
 * Item Lists node (`core.data.itemLists`): limit, dedupe, sort, split out,
 * summarize, or concatenate a list of items.
 */
@node("core.data.itemLists", {
  kind: "core.data.itemLists",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-list-details",
  width: 96,
  height: 96,
  labels: ["data", "list", "items", "transform"],
  metadata: {
    title: "graph.node.data.item_lists.name",
    description: "graph.node.data.item_lists.description",
  },
})
@model()
export class ItemListsNode extends GraphNode<
  ItemListsNodeInput,
  ItemListsNodeOutput
> {

  /**
   * Executes the configured item-list operation.
   *
   * @param request - Execution request; `inputs.value` holds the item collection.
   * @returns Execution values with the transformed `result` and, for
   *   `removeDuplicates`, the `discarded` duplicates.
   * @throws {GraphExecutionError} `GRAPH_ITEM_LISTS_UNSUPPORTED_OPERATION`,
   *   `GRAPH_ITEM_LISTS_FIELD_REQUIRED` (split out without a field),
   *   `GRAPH_SUMMARIZE_FIELDS_REQUIRED`, or `GRAPH_AGGREGATE_FIELDS_REQUIRED`
   *   (concatenate without field specs).
   */
  override execute(
    request: GraphNodeExecutionRequest<ItemListsNodeInput>
  ): GraphExecutionValues {
    const items = asGraphDataArray(request.inputs["value"]);
    switch (this.operation) {
      case "limit": {
        const maxItems = Math.max(0, Math.floor(Number(this.maxItems ?? 1)));
        const limited =
          this.keep === "lastItems"
            ? items.slice(Math.max(0, items.length - maxItems))
            : items.slice(0, maxItems);
        return { result: limited };
      }
      case "removeDuplicates": {
        const { kept, discarded } = dedupeGraphItems(items, {
          compare: this.compareMode,
          fieldsToExclude: this.fieldsToExclude,
          fieldsToCompare: this.fieldsToCompare,
          removeOtherFields: this.removeOtherFields === true,
          dotNotation: this.disableDotNotation !== true,
        });
        return { result: kept, discarded };
      }
      case "sort":
        return {
          result: sortGraphItems(
            items,
            this.sortFields ?? [],
            this.disableDotNotation !== true,
            this.sortValueType ?? "auto"
          ),
        };
      case "splitOutItems": {
        if (!this.field) {
          throw new GraphExecutionError(
            "Item Lists node split out operation requires a field name",
            "GRAPH_ITEM_LISTS_FIELD_REQUIRED"
          );
        }
        return {
          result: splitGraphOutItems(items, this.field, {
            include: this.splitOutInclude,
            destinationField: this.destinationField,
            dotNotation: this.disableDotNotation !== true,
          }),
        };
      }
      case "summarize": {
        const fields = (this.fieldsToSummarize ?? []).filter(
          (entry) => entry && typeof entry.aggregation === "string"
        );
        if (fields.length === 0) {
          throw new GraphExecutionError(
            "Item Lists node summarize operation requires at least one field",
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
      case "concatenateItems":
        break;
      default:
        throw new GraphExecutionError(
          `Item Lists operation '${String(this.operation)}' is not supported`,
          "GRAPH_ITEM_LISTS_UNSUPPORTED_OPERATION",
          { operation: this.operation }
        );
    }

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
        "Item Lists node concatenate operation requires at least one field",
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

  /** Items to process (array, single item, or nil). */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Operation to perform (default `concatenateItems`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: ItemListsOperation = "concatenateItems";

  /** Concatenation strategy used by `concatenateItems` (default `aggregateIndividualFields`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.aggregate.label",
    type: "select",
  })
  @input({ handle: "aggregate", userControlled: true })
  aggregate: ItemListsAggregateMode = "aggregateIndividualFields";

  /** Source fields to concatenate, with optional rename/output-name options. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.fieldsToAggregate.label",
    placeholder: "graph.node.data.item_lists.fields.fieldsToAggregate.placeholder",
    type: "collection",
  })
  @input({ handle: "fieldsToAggregate", userControlled: true, type: "array" })
  fieldsToAggregate?: AggregateFieldSpec[] = [];

  /** Destination field when concatenating all item data (default `data`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.destinationFieldName.label",
    type: "text",
  })
  @input({ handle: "destinationFieldName", userControlled: true })
  destinationFieldName: string = "data";

  /** Field projection when concatenating all item data (default `allFields`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.include.label",
    type: "select",
  })
  @input({ handle: "include", userControlled: true })
  include: ItemListsInclude = "allFields";

  /** Comma-separated or array field list kept when `include` is `specifiedFields`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.fieldsToInclude.label",
    placeholder: "graph.node.data.item_lists.fields.fieldsToInclude.placeholder",
    type: "text",
  })
  @input({ handle: "fieldsToInclude", userControlled: true })
  fieldsToInclude?: string | string[];

  /** Comma-separated or array field list dropped when `include` is `allFieldsExcept`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.fieldsToExclude.label",
    placeholder: "graph.node.data.item_lists.fields.fieldsToExclude.placeholder",
    type: "text",
  })
  @input({ handle: "fieldsToExclude", userControlled: true })
  fieldsToExclude?: string | string[];

  /** Flatten array values into a single concatenated list (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.mergeLists.label",
    type: "checkbox",
  })
  @input({ handle: "mergeLists", userControlled: true })
  mergeLists?: boolean = false;

  /** Keep `null`/`undefined` concatenated values instead of skipping them (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.keepMissing.label",
    type: "checkbox",
  })
  @input({ handle: "keepMissing", userControlled: true })
  keepMissing?: boolean = false;

  /** Maximum number of items kept by `limit` (default `1`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.maxItems.label",
    type: "number",
  })
  @input({ handle: "maxItems", userControlled: true })
  maxItems: number = 1;

  /** Which end `limit` keeps (default `firstItems`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.keep.label",
    type: "select",
  })
  @input({ handle: "keep", userControlled: true })
  keep: "firstItems" | "lastItems" = "firstItems";

  /** Field selection used by `removeDuplicates` (default `allFields`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.compareMode.label",
    type: "select",
  })
  @input({ handle: "compareMode", userControlled: true })
  compareMode: CompareMode = "allFields";

  /** Comma-separated or array fields compared when `compareMode` is `selectedFields`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.fieldsToCompare.label",
    placeholder: "graph.node.data.item_lists.fields.fieldsToCompare.placeholder",
    type: "text",
  })
  @input({ handle: "fieldsToCompare", userControlled: true })
  fieldsToCompare?: string | string[];

  /** Project kept items onto the compared fields only (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.removeOtherFields.label",
    type: "checkbox",
  })
  @input({ handle: "removeOtherFields", userControlled: true })
  removeOtherFields?: boolean = false;

  /** Sort keys and directions used by `sort`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.sortFields.label",
    placeholder: "graph.node.data.item_lists.fields.sortFields.placeholder",
    type: "collection",
  })
  @input({ handle: "sortFields", userControlled: true, type: "array" })
  sortFields?: SortSpec[] = [];

  /** Value coercion used when comparing sort keys (default `auto`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.sortValueType.label",
    type: "select",
  })
  @input({ handle: "sortValueType", userControlled: true })
  sortValueType: "auto" | "string" | "number" | "date" = "auto";

  /** Array-valued field expanded by `splitOutItems`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.field.label",
    placeholder: "graph.node.data.item_lists.fields.field.placeholder",
    type: "text",
  })
  @input({ handle: "field", userControlled: true })
  field: string = "";

  /** Whether `splitOutItems` keeps the other item fields (default `noOtherFields`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.splitOutInclude.label",
    type: "select",
  })
  @input({ handle: "splitOutInclude", userControlled: true })
  splitOutInclude: "noOtherFields" | "allOtherFields" = "noOtherFields";

  /** Field receiving the split-out value when other fields are kept. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.destinationField.label",
    placeholder: "graph.node.data.item_lists.fields.destinationField.placeholder",
    type: "text",
  })
  @input({ handle: "destinationField", userControlled: true })
  destinationField?: string;

  /** Aggregations applied by `summarize`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.fieldsToSummarize.label",
    placeholder:
      "graph.node.data.item_lists.fields.fieldsToSummarize.placeholder",
    type: "collection",
  })
  @input({ handle: "fieldsToSummarize", userControlled: true, type: "array" })
  fieldsToSummarize?: SummarizeField[] = [];

  /** Grouping fields used by `summarize`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.fieldsToSplitBy.label",
    placeholder: "graph.node.data.item_lists.fields.fieldsToSplitBy.placeholder",
    type: "text",
  })
  @input({ handle: "fieldsToSplitBy", userControlled: true })
  fieldsToSplitBy?: string | string[];

  /** Whether `summarize` returns one item per group or a single nested record (default `separateItems`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.outputFormat.label",
    type: "select",
  })
  @input({ handle: "outputFormat", userControlled: true })
  outputFormat: "separateItems" | "singleItem" = "separateItems";

  /** Skip items whose split fields are empty (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.skipEmptySplitFields.label",
    type: "checkbox",
  })
  @input({ handle: "skipEmptySplitFields", userControlled: true })
  skipEmptySplitFields?: boolean = false;

  /** Summarize a missing field as empty instead of failing (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.continueIfFieldNotFound.label",
    type: "checkbox",
  })
  @input({ handle: "continueIfFieldNotFound", userControlled: true })
  continueIfFieldNotFound?: boolean = false;

  /** Treat field names literally instead of as dot-separated paths (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.item_lists.fields.disableDotNotation.label",
    type: "checkbox",
  })
  @input({ handle: "disableDotNotation", userControlled: true })
  disableDotNotation?: boolean = false;

  /** Operation result. */
  @required()
  @output({ handle: "result" })
  result!: unknown;

  /** Duplicates removed by `removeDuplicates`. */
  @output({ handle: "discarded" })
  discarded?: unknown[];
}
