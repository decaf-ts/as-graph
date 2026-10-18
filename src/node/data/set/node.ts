/**
 * @module as-graph/nodes/data/set
 * @summary Set data node declaration (DECAF-746 Data family).
 * @description Set — assign fields onto the input. A `SetAssignment` list
 * (name, optional target type, value) is coerced with `coerceGraphDataSetValue`
 * and written onto a copy of the input at the configured path. With
 * `includeOtherFields` the existing fields of a record input are carried over
 * (an `undefined` input starts from `{}`, any other input becomes `{ value }`);
 * without it only the assignments survive. `dotNotation` (default on) decides
 * whether assignment names address nested paths or literal keys. Array input is
 * mapped item by item — array-in, array-out.
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
  coerceGraphDataSetValue,
  isGraphDataRecord,
  setGraphDataValue,
  type GraphDataSetValueType,
} from "../support";

/**
 * A single configured assignment of the Set node.
 */
export interface SetAssignment {
  /** Target field name; a dotted path when `dotNotation` is enabled. */
  name: string;
  /** Coercion target type; defaults to `json`. */
  type?: GraphDataSetValueType;
  /** The value to assign; nil values are skipped. */
  value?: unknown;
}

/** Inputs accepted by the Set node. */
export type SetNodeInput = Record<string, unknown>;

/** Outputs produced by the Set node. */
export interface SetNodeOutput {
  result: unknown;
}

/**
 * Set data node: assigns configured fields onto a copy of the input value.
 */
@node("core.data.set", {
  kind: "core.data.set",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-adjustments-horizontal",
  width: 96,
  height: 96,
  labels: ["data", "set", "assign"],
  metadata: {
    title: "graph.node.data.set.name",
    description: "graph.node.data.set.description",
  },
})
@model()
export class SetNode extends GraphNode<SetNodeInput, SetNodeOutput> {
  /**
   * Maps the `value` input through {@linkcode SetNode.applyTo}: array input
   * produces one assigned record per item; any other input produces a single
   * assigned record.
   *
   * @param request - The execution request carrying the `value` input.
   * @returns The assigned record(s) under `result`.
   */
  override execute(
    request: GraphNodeExecutionRequest<SetNodeInput>
  ): GraphExecutionValues {
    const value = request.inputs["value"];
    if (Array.isArray(value)) {
      return {
        result: value
          .filter((item) => item !== undefined && item !== null)
          .map((item) => this.applyTo(item)),
      };
    }
    return { result: this.applyTo(value) };
  }

  /**
   * Builds the output record for one input value.
   *
   * Starts from the input's own fields when `includeOtherFields` is set (an
   * `undefined` input starts empty, a non-record input is wrapped as
   * `{ value }`), then writes each valid assignment through
   * `setGraphDataValue` after coercion. Nil coerced values and assignments
   * without a string `name` are skipped.
   *
   * @param value - The input value to assign onto.
   * @returns The assigned record.
   */
  private applyTo(value: unknown): Record<string, unknown> {
    const result: Record<string, unknown> = this.includeOtherFields
      ? isGraphDataRecord(value)
        ? { ...value }
        : value === undefined
          ? {}
          : { value }
      : {};

    for (const assignment of this.assignments ?? []) {
      if (!assignment || typeof assignment.name !== "string") continue;
      const assigned = coerceGraphDataSetValue(
        assignment.value,
        assignment.type ?? "json"
      );
      if (assigned === undefined || assigned === null) continue;
      setGraphDataValue(
        result,
        assignment.name,
        assigned,
        this.dotNotation !== false
      );
    }

    return result;
  }

  @required()
  @input({ handle: "value" })
  value!: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.set.fields.assignments.label",
    placeholder: "graph.node.data.set.fields.assignments.placeholder",
    type: "collection",
  })
  @input({ handle: "assignments", userControlled: true, type: "array" })
  assignments?: SetAssignment[] = [];

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.set.fields.includeOtherFields.label",
    type: "checkbox",
  })
  @input({ handle: "includeOtherFields", userControlled: true })
  includeOtherFields: boolean = true;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.set.fields.dotNotation.label",
    type: "checkbox",
  })
  @input({ handle: "dotNotation", userControlled: true })
  dotNotation: boolean = true;

  @required()
  @output({ handle: "result" })
  result!: unknown;
}
