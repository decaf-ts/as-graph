/**
 * @module as-graph/nodes/data/merge
 * @summary Merge data node declaration (DECAF-746 Data family).
 * @description Merge — combine two inputs into one array. `append` mode
 * concatenates the item arrays. `combine` mode pairs items either `byFields`
 * (a key-based join on `joinField` with `inner`/`left`/`right`/`outer`
 * semantics) or by `position`. Record pairs are merged with the configured
 * `clashHandling` (`keepFirst` keeps the left value, `keepLast` overwrites it);
 * non-record pairs become `[left, right]` tuples. Unpaired items follow the
 * `joinMode`: `inner` drops them, `left`/`right` keep only the corresponding
 * side's items in position mode, and `outer` keeps both. The output is always
 * an array — array-in, array-out.
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
  getGraphDataValue,
  isGraphDataRecord,
} from "../support";

/** How the two inputs are combined. */
export type MergeMode = "append" | "combine";

/** Combine strategy in `combine` mode. */
export type MergeCombineBy = "position" | "fields";

/** Which unmatched items survive the join. */
export type MergeJoinMode = "inner" | "left" | "right" | "outer";

/** Which side wins when both records define the same key. */
export type MergeClashHandling = "keepFirst" | "keepLast";

/** Inputs accepted by the Merge node. */
export interface MergeNodeInput {
  input?: unknown;
  input2?: unknown;
}

/** Outputs produced by the Merge node. */
export interface MergeNodeOutput {
  result: unknown[];
}

/**
 * Merges the right record into a copy of the left one, applying the configured
 * clash handling: `keepFirst` keeps the left value for shared keys,
 * `keepLast` (or anything else) lets the right value win.
 *
 * @param left - The base record.
 * @param right - The record whose entries overlay the base.
 * @param clashHandling - The configured clash handling.
 * @returns The merged record.
 */
function mergeRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  clashHandling: MergeClashHandling
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (
      clashHandling === "keepFirst" &&
      Object.prototype.hasOwnProperty.call(result, key)
    ) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * Merge data node: appends or joins the items of the `input` and `input2`
 * inputs into a single result array.
 */
@node("core.data.merge", {
  kind: "core.data.merge",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-git-merge",
  width: 96,
  height: 96,
  labels: ["data", "merge", "join"],
  metadata: {
    title: "graph.node.data.merge.name",
    description: "graph.node.data.merge.description",
  },
})
@model()
export class MergeNode extends GraphNode<MergeNodeInput, MergeNodeOutput> {
  /**
   * Runs the configured merge mode against the two inputs.
   *
   * `append` concatenates; `combine` dispatches to {@linkcode MergeNode.mergeByFields}
   * (`fields`) or the positional pairing loop below. Positional pairing merges
   * record pairs and wraps non-record pairs as `[left, right]`, honouring the
   * `joinMode` for out-of-range indices.
   *
   * @param request - The execution request carrying `input` and `input2`.
   * @returns The merged items under `result`.
   * @throws {GraphExecutionError} with code `GRAPH_MERGE_JOIN_FIELD_REQUIRED`
   *   when `combineBy` is `fields` and no `joinField` is configured.
   */
  override execute(
    request: GraphNodeExecutionRequest<MergeNodeInput>
  ): GraphExecutionValues {
    const left = asGraphDataArray(request.inputs["input"]);
    const right = asGraphDataArray(request.inputs["input2"]);

    if (this.mode === "append") {
      return { result: [...left, ...right] };
    }

    if (this.combineBy === "fields") {
      return {
        result: this.mergeByFields(left, right),
      };
    }

    const length = Math.max(left.length, right.length);
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      if (index >= left.length) {
        if (this.joinMode === "inner" || this.joinMode === "left") continue;
        result.push(right[index]);
        continue;
      }
      if (index >= right.length) {
        if (this.joinMode === "inner" || this.joinMode === "right") continue;
        result.push(left[index]);
        continue;
      }
      const leftItem = left[index];
      const rightItem = right[index];
      if (isGraphDataRecord(leftItem) && isGraphDataRecord(rightItem)) {
        result.push(mergeRecords(leftItem, rightItem, this.clashHandling));
      } else {
        result.push([leftItem, rightItem]);
      }
    }
    return { result };
  }

  /**
   * Key-based join of the left and right item lists on `joinField`.
   *
   * Right items are indexed by their `joinField` value (duplicate keys fold
   * together with the configured clash handling); each left record is then
   * merged with its match. Unmatched left items follow the `joinMode`
   * (`inner`/`right` drop them, `left`/`outer` keep them), and `right`/`outer`
   * append right items whose key was never matched, in key order.
   *
   * @param left - The left item list.
   * @param right - The right item list.
   * @returns The joined items.
   * @throws {GraphExecutionError} with code `GRAPH_MERGE_JOIN_FIELD_REQUIRED`
   *   when no `joinField` is configured.
   */
  private mergeByFields(left: unknown[], right: unknown[]): unknown[] {
    const joinField = this.joinField;
    if (!joinField) {
      throw new GraphExecutionError(
        "Merge node in 'fields' mode requires a join field",
        "GRAPH_MERGE_JOIN_FIELD_REQUIRED"
      );
    }
    const rightByKey = new Map<unknown, Record<string, unknown>>();
    for (const item of right) {
      if (!isGraphDataRecord(item)) continue;
      const key = getGraphDataValue(item, joinField);
      if (key === undefined || key === null) continue;
      const existing = rightByKey.get(key);
      rightByKey.set(
        key,
        existing ? mergeRecords(existing, item, this.clashHandling) : item
      );
    }

    const result: unknown[] = [];
    const matched = new Set<unknown>();
    for (const item of left) {
      if (!isGraphDataRecord(item)) {
        if (this.joinMode !== "inner" && this.joinMode !== "right") {
          result.push(item);
        }
        continue;
      }
      const key = getGraphDataValue(item, joinField);
      const other = rightByKey.get(key);
      if (other) {
        matched.add(key);
        result.push(mergeRecords(item, other, this.clashHandling));
      } else if (this.joinMode !== "inner" && this.joinMode !== "right") {
        result.push(item);
      }
    }

    if (this.joinMode === "right" || this.joinMode === "outer") {
      for (const [key, item] of rightByKey) {
        if (!matched.has(key)) result.push(item);
      }
    }

    return result;
  }

  @required()
  @input({ handle: "input" })
  input!: unknown;

  @input({ handle: "input2" })
  input2?: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.merge.fields.mode.label",
    type: "select",
  })
  @input({ handle: "mode", userControlled: true })
  mode: MergeMode = "append";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.merge.fields.combineBy.label",
    type: "select",
  })
  @input({ handle: "combineBy", userControlled: true })
  combineBy: MergeCombineBy = "position";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.merge.fields.joinMode.label",
    type: "select",
  })
  @input({ handle: "joinMode", userControlled: true })
  joinMode: MergeJoinMode = "inner";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.merge.fields.joinField.label",
    placeholder: "graph.node.data.merge.fields.joinField.placeholder",
    type: "text",
  })
  @input({ handle: "joinField", userControlled: true })
  joinField?: string;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.merge.fields.clashHandling.label",
    type: "select",
  })
  @input({ handle: "clashHandling", userControlled: true })
  clashHandling: MergeClashHandling = "keepFirst";

  @required()
  @output({ handle: "result" })
  result!: unknown[];
}
