/**
 * @module as-graph/nodes/data/limit
 * @summary Limit data node declaration (DECAF-746 Data family).
 * @description Limit — keep only the first or last `maxItems` of the input
 * array. `maxItems` is floored and clamped to `>= 0` (an invalid or absent
 * value falls back to 1); when the clamped count covers the whole input the
 * input array is returned unchanged. The output is always an array —
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
import { asGraphDataArray } from "../support";

/** Which end of the array `maxItems` is kept from. */
export type LimitKeep = "firstItems" | "lastItems";

/** Inputs accepted by the Limit node. */
export type LimitNodeInput = Record<string, unknown>;

/** Outputs produced by the Limit node. */
export interface LimitNodeOutput {
  result: unknown[];
}

/**
 * Limit data node: slices the input array down to `maxItems` items from the
 * configured end.
 */
@node("core.data.limit", {
  kind: "core.data.limit",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-arrows-bar-to-line",
  width: 96,
  height: 96,
  labels: ["data", "limit", "slice"],
  metadata: {
    title: "graph.node.data.limit.name",
    description: "graph.node.data.limit.description",
  },
})
@model()
export class LimitNode extends GraphNode<LimitNodeInput, LimitNodeOutput> {
  /**
   * Slices the input to the clamped `maxItems` from `firstItems` or
   * `lastItems`.
   *
   * @param request - The execution request carrying the `value` input.
   * @returns The kept items under `result`.
   */
  override execute(
    request: GraphNodeExecutionRequest<LimitNodeInput>
  ): GraphExecutionValues {
    const items = asGraphDataArray(request.inputs["value"]);
    const maxItems = Math.max(0, Math.floor(Number(this.maxItems ?? 1)));
    if (maxItems >= items.length) return { result: items };
    if (this.keep === "lastItems") {
      return { result: items.slice(items.length - maxItems) };
    }
    return { result: items.slice(0, maxItems) };
  }

  @required()
  @input({ handle: "value" })
  value!: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.limit.fields.maxItems.label",
    type: "number",
  })
  @input({ handle: "maxItems", userControlled: true })
  maxItems: number = 1;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.limit.fields.keep.label",
    type: "select",
  })
  @input({ handle: "keep", userControlled: true })
  keep: LimitKeep = "firstItems";

  @required()
  @output({ handle: "result" })
  result!: unknown[];
}
