/**
 * @module as-graph/nodes/data/remove-duplicates
 * @description Removes duplicate items either across every field, every field
 * except an excluded list, or a selected field list. The first occurrence of
 * each signature is kept; later duplicates are emitted on `discarded`, and
 * `removeOtherFields` can project kept items onto the compared fields only.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { asGraphDataArray } from "../support";
import {
  dedupeGraphItems,
  type CompareMode,
} from "../transform-utils";

/** Field selection used for duplicate detection. */
export type RemoveDuplicatesCompare = CompareMode;

/** Inputs accepted by the Remove Duplicates node; `value` carries the item collection. */
export type RemoveDuplicatesNodeInput = Record<string, unknown>;

/** Outputs produced by the Remove Duplicates node. */
export interface RemoveDuplicatesNodeOutput {
  /** Unique items, in first-seen order. */
  result: unknown[];
  /** Items removed because their comparison signature was already seen. */
  discarded?: unknown[];
}

/**
 * Remove Duplicates node (`core.data.removeDuplicates`): keeps the first item
 * of each comparison signature and emits the rest on `discarded`.
 */
@node("core.data.removeDuplicates", {
  kind: "core.data.removeDuplicates",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-copy-off",
  width: 96,
  height: 96,
  labels: ["data", "dedupe", "duplicates", "unique"],
  metadata: {
    title: "graph.node.data.remove_duplicates.name",
    description: "graph.node.data.remove_duplicates.description",
  },
})
@model()
export class RemoveDuplicatesNode extends GraphNode<
  RemoveDuplicatesNodeInput,
  RemoveDuplicatesNodeOutput
> {
  /**
   * Removes duplicate input items.
   *
   * @param request - Execution request; `inputs.value` holds the item collection.
   * @returns Execution values with the unique `result` and removed `discarded` items.
   * @throws {GraphExecutionError} `GRAPH_REMOVE_DUPLICATES_FIELDS_REQUIRED`
   *   when `selectedFields`/`allFieldsExcept` has no configured field list, or
   *   `GRAPH_REMOVE_DUPLICATES_FIELD_MISSING` when selected fields are absent
   *   from every item.
   */
  override execute(
    request: GraphNodeExecutionRequest<RemoveDuplicatesNodeInput>
  ): GraphExecutionValues {
    const items = asGraphDataArray(request.inputs["value"]);
    const { kept, discarded } = dedupeGraphItems(items, {
      compare: this.compareMode,
      fieldsToExclude: this.fieldsToExclude,
      fieldsToCompare: this.fieldsToCompare,
      removeOtherFields: this.removeOtherFields === true,
      dotNotation: this.disableDotNotation !== true,
    });
    return { result: kept, discarded };
  }

  /** Items to deduplicate (array, single item, or nil). */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Field selection used for comparison (default `allFields`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.remove_duplicates.fields.compareMode.label",
    type: "select",
  })
  @input({ handle: "compareMode", userControlled: true })
  compareMode: RemoveDuplicatesCompare = "allFields";

  /** Comma-separated or array fields compared when `compareMode` is `selectedFields`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.remove_duplicates.fields.fieldsToCompare.label",
    placeholder:
      "graph.node.data.remove_duplicates.fields.fieldsToCompare.placeholder",
    type: "text",
  })
  @input({ handle: "fieldsToCompare", userControlled: true })
  fieldsToCompare?: string | string[];

  /** Comma-separated or array fields ignored when `compareMode` is `allFieldsExcept`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.remove_duplicates.fields.fieldsToExclude.label",
    placeholder:
      "graph.node.data.remove_duplicates.fields.fieldsToExclude.placeholder",
    type: "text",
  })
  @input({ handle: "fieldsToExclude", userControlled: true })
  fieldsToExclude?: string | string[];

  /** Project kept items onto the compared fields only (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.remove_duplicates.fields.removeOtherFields.label",
    type: "checkbox",
  })
  @input({ handle: "removeOtherFields", userControlled: true })
  removeOtherFields?: boolean = false;

  /** Treat field names literally instead of as dot-separated paths (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.remove_duplicates.fields.disableDotNotation.label",
    type: "checkbox",
  })
  @input({ handle: "disableDotNotation", userControlled: true })
  disableDotNotation?: boolean = false;

  /** Unique items. */
  @required()
  @output({ handle: "result" })
  result!: unknown[];

  /** Removed duplicates. */
  @output({ handle: "discarded" })
  discarded?: unknown[];
}
