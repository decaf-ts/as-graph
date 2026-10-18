/**
 * @module as-graph/nodes/data/rename-keys
 * @summary Rename Keys data node declaration (DECAF-746 Data family).
 * @description Rename Keys — move values between keys of a record. Each
 * `RenameKeyRule` reads `from` (dot-notation toggleable), deletes it, and
 * writes the value at `to`; rules missing either key, or with `from === to`,
 * are skipped, and a missing `from` value is a no-op for that rule. Array
 * input renames within each record item (non-records pass through), a record
 * input is renamed directly, and any other input is normalized with
 * `asGraphDataArray` and returned unchanged. The input is copied before
 * mutation — the original is never modified.
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
  deleteGraphDataValue,
  getGraphDataValue,
  isGraphDataRecord,
  setGraphDataValue,
} from "../support";

/** A single configured key rename. */
export interface RenameKeyRule {
  /** Source key path of the value to move. */
  from: string;
  /** Destination key path to write the value at. */
  to: string;
}

/** Inputs accepted by the Rename Keys node. */
export type RenameKeysNodeInput = Record<string, unknown>;

/** Outputs produced by the Rename Keys node. */
export interface RenameKeysNodeOutput {
  result: unknown;
}

/**
 * Applies the rename rules to a copy of a record.
 *
 * @param source - The record to copy and rename within.
 * @param rules - The validated rename rules.
 * @param dotNotation - Whether `from`/`to` address nested paths.
 * @returns The renamed copy.
 */
function renameKeysInRecord(
  source: Record<string, unknown>,
  rules: RenameKeyRule[],
  dotNotation: boolean
): Record<string, unknown> {
  const target: Record<string, unknown> = { ...source };
  for (const rule of rules) {
    if (!rule || !rule.from || !rule.to || rule.from === rule.to) continue;
    const value = getGraphDataValue(target, rule.from, dotNotation);
    if (value === undefined) continue;
    deleteGraphDataValue(target, rule.from, dotNotation);
    setGraphDataValue(target, rule.to, value, dotNotation);
  }
  return target;
}

/**
 * Rename Keys data node: moves values between keys of the input record(s)
 * according to the configured rename rules.
 */
@node("core.data.renameKeys", {
  kind: "core.data.renameKeys",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-key",
  width: 96,
  height: 96,
  labels: ["data", "rename", "keys"],
  metadata: {
    title: "graph.node.data.rename_keys.name",
    description: "graph.node.data.rename_keys.description",
  },
})
@model()
export class RenameKeysNode extends GraphNode<
  RenameKeysNodeInput,
  RenameKeysNodeOutput
> {
  /**
   * Applies the rename rules to the input value.
   *
   * Rules without string `from`/`to` are filtered out before anything runs.
   *
   * @param request - The execution request carrying the `value` input.
   * @returns The renamed value(s) under `result`, normalized as described in
   *   the module description.
   */
  override execute(
    request: GraphNodeExecutionRequest<RenameKeysNodeInput>
  ): GraphExecutionValues {
    const rules = (this.renames ?? []).filter(
      (rule) => rule && typeof rule.from === "string" && typeof rule.to === "string"
    );
    const value = request.inputs["value"];
    const dotNotation = this.dotNotation !== false;

    if (Array.isArray(value)) {
      return {
        result: value
          .filter((item) => item !== undefined && item !== null)
          .map((item) =>
          isGraphDataRecord(item)
            ? renameKeysInRecord(item, rules, dotNotation)
            : item
        ),
      };
    }

    if (isGraphDataRecord(value)) {
      return { result: renameKeysInRecord(value, rules, dotNotation) };
    }

    return { result: asGraphDataArray(value) };
  }

  @required()
  @input({ handle: "value" })
  value!: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.rename_keys.fields.renames.label",
    placeholder: "graph.node.data.rename_keys.fields.renames.placeholder",
    type: "collection",
  })
  @input({ handle: "renames", userControlled: true, type: "array" })
  renames?: RenameKeyRule[] = [];

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.rename_keys.fields.dotNotation.label",
    type: "checkbox",
  })
  @input({ handle: "dotNotation", userControlled: true })
  dotNotation: boolean = true;

  @required()
  @output({ handle: "result" })
  result!: unknown;
}
