/**
 * @module as-graph/nodes/data/sort
 * @summary Sort data node declaration (DECAF-746 Data family).
 * @description Sort — order the input array by one or more fields. Each
 * `SortField` is applied in order; the first non-zero comparison wins, with
 * `desc` inverting it. Values are read with dot-notation support (toggleable)
 * and compared through `compareGraphDataValues` using the configured
 * `valueType` (`auto` compares numbers/booleans numerically, everything else
 * by string). Items are sorted in place on a copy — the input array itself is
 * never mutated — and with no valid sort fields configured the copy is
 * returned unchanged. The output is always an array — array-in, array-out.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import {
  asGraphDataArray,
  compareGraphDataValues,
  getGraphDataValue,
} from "../support";

/** Sort direction of a single sort field. */
export type SortDirection = "asc" | "desc";

/** Comparison mode applied to the extracted values. */
export type SortValueType = "auto" | "string" | "number" | "date";

/** A single configured sort criterion. */
export interface SortField {
  /** Field path to compare (dot notation when enabled). */
  field: string;
  /** Direction; anything other than `"desc"` sorts ascending. */
  direction?: SortDirection;
}

/** Inputs accepted by the Sort node. */
export type SortNodeInput = Record<string, unknown>;

/** Outputs produced by the Sort node. */
export interface SortNodeOutput {
  result: unknown[];
}

/**
 * Sort data node: orders a copy of the input array by the configured sort
 * fields.
 */
@node("core.data.sort", {
  kind: "core.data.sort",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-sort-ascending",
  width: 96,
  height: 96,
  labels: ["data", "sort", "order"],
  metadata: {
    title: "graph.node.data.sort.name",
    description: "graph.node.data.sort.description",
  },
})
@model()
export class SortNode extends GraphNode<SortNodeInput, SortNodeOutput> {
  /**
   * Sorts a copy of the input array with the configured fields.
   *
   * Entries without a valid string `field` are filtered out; with none left,
   * the input order is preserved as-is.
   *
   * @param request - The execution request carrying the `value` input.
   * @returns The sorted items under `result`.
   */
  override execute(
    request: GraphNodeExecutionRequest<SortNodeInput>
  ): GraphExecutionValues {
    const items = [...asGraphDataArray(request.inputs["value"])];
    const fields = (this.sortFields ?? []).filter(
      (field) => field && typeof field.field === "string"
    );
    if (fields.length === 0) return { result: items };

    items.sort((left, right) => {
      for (const field of fields) {
        const comparison = compareGraphDataValues(
          getGraphDataValue(left, field.field, this.dotNotation !== false),
          getGraphDataValue(right, field.field, this.dotNotation !== false),
          this.valueType ?? "auto"
        );
        if (comparison !== 0) {
          return field.direction === "desc" ? -comparison : comparison;
        }
      }
      return 0;
    });

    return { result: items };
  }

  @required()
  @input({ handle: "value" })
  value!: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.sort.fields.sortFields.label",
    placeholder: "graph.node.data.sort.fields.sortFields.placeholder",
    type: "collection",
  })
  @input({ handle: "sortFields", userControlled: true, type: "array" })
  sortFields?: SortField[] = [];

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.sort.fields.valueType.label",
    type: "select",
  })
  @input({ handle: "valueType", userControlled: true })
  valueType: SortValueType = "auto";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.sort.fields.dotNotation.label",
    type: "checkbox",
  })
  @input({ handle: "dotNotation", userControlled: true })
  dotNotation: boolean = true;

  @required()
  @output({ handle: "result" })
  result!: unknown[];
}
