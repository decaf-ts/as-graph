/**
 * @module as-graph/nodes/data/split-out
 * @summary Split Out data node declaration (DECAF-746 Data family).
 * @description Split Out — explode a field into items. For each input item the
 * configured `field` is read (dot notation always applies); `undefined`/`null`
 * field values are skipped, arrays are exploded one level, and any other value
 * becomes a single item. With the default `noOtherFields` include mode the
 * entries are emitted bare; with `allOtherFields` each entry is embedded into a
 * copy of the source item at `destinationField` (defaulting to the source
 * `field`), from which the original field value is first deleted. Nil entries
 * inside an exploded array are skipped. The output is always an array —
 * array-in, array-out.
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
import {
  asGraphDataArray,
  deleteGraphDataValue,
  getGraphDataValue,
  isGraphDataRecord,
  setGraphDataValue,
} from "../support";

/** Which other fields accompany each split-out entry. */
export type SplitOutInclude = "noOtherFields" | "allOtherFields";

/** Inputs accepted by the Split Out node. */
export type SplitOutNodeInput = Record<string, unknown>;

/** Outputs produced by the Split Out node. */
export interface SplitOutNodeOutput {
  result: unknown[];
}

/**
 * Split Out data node: explodes the values stored under a configured field
 * into individual items.
 */
@node("core.data.splitOut", {
  kind: "core.data.splitOut",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-arrows-split-2",
  width: 96,
  height: 96,
  labels: ["data", "split", "array"],
  metadata: {
    title: "graph.node.data.split_out.name",
    description: "graph.node.data.split_out.description",
  },
})
@model()
export class SplitOutNode extends GraphNode<
  SplitOutNodeInput,
  SplitOutNodeOutput
> {
  /**
   * Explodes the configured field of every input item into result entries.
   *
   * @param request - The execution request carrying the `value` input.
   * @returns The split-out entries under `result`.
   * @throws {GraphExecutionError} with code `GRAPH_SPLIT_OUT_FIELD_REQUIRED`
   *   when no `field` is configured.
   */
  override execute(
    request: GraphNodeExecutionRequest<SplitOutNodeInput>
  ): GraphExecutionValues {
    if (!this.field) {
      throw new GraphExecutionError(
        "Split Out node requires a field name",
        "GRAPH_SPLIT_OUT_FIELD_REQUIRED"
      );
    }

    const items = asGraphDataArray(request.inputs["value"]);
    const result: unknown[] = [];
    for (const item of items) {
      const value = getGraphDataValue(item, this.field, true);
      if (value === undefined || value === null) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        if (entry === undefined || entry === null) continue;
        if (this.include !== "allOtherFields") {
          result.push(entry);
          continue;
        }
        const destination = this.destinationField || this.field;
        const base: Record<string, unknown> = isGraphDataRecord(item)
          ? { ...item }
          : {};
        deleteGraphDataValue(base, this.field, true);
        setGraphDataValue(base, destination, entry, true);
        result.push(base);
      }
    }

    return { result };
  }

  @required()
  @input({ handle: "value" })
  value!: unknown;

  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.split_out.fields.field.label",
    placeholder: "graph.node.data.split_out.fields.field.placeholder",
    type: "text",
  })
  @input({ handle: "field", userControlled: true })
  field: string = "";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.split_out.fields.include.label",
    type: "select",
  })
  @input({ handle: "include", userControlled: true })
  include: SplitOutInclude = "noOtherFields";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.split_out.fields.destinationField.label",
    placeholder:
      "graph.node.data.split_out.fields.destinationField.placeholder",
    type: "text",
  })
  @input({ handle: "destinationField", userControlled: true })
  destinationField?: string;

  @required()
  @output({ handle: "result" })
  result!: unknown[];
}
