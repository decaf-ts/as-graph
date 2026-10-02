/**
 * @module as-graph/nodes/boundary/input
 * @summary Workflow input value boundary node declaration.
 * @description Shared canvas node representing a workflow input value
 * (decorator id `graph-input-value-node`), moved from the for-angular
 * boundary nodes so both sides share the declaration. Reusable value node
 * whose single `value` output may feed multiple targets. As an input boundary
 * node it receives no upstream data (`INPUT = void`).
 */
import { model } from "@decaf-ts/decorator-validation";
import { output, node } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Outputs produced by the workflow input value boundary node. */
export interface GraphInputValueOutput {
  value: unknown;
}

/**
 * Workflow input value boundary node: a reusable value node whose single `value` output may feed multiple targets.
 */
@node("graph-input-value-node", {
  kind: "value",
  category: "Boundary",
  color: "#0f766e",
  icon: "ti-circle-plus",
  labels: ["workflow", "input", "value"],
  metadata: {
    title: "graph.node.boundary.input.name",
    description: "graph.node.boundary.input.description",
  },
})
@model()
export class GraphInputValueNode extends GraphNode<
  void,
  GraphInputValueOutput
> {
  /**
   * Returns the `value` supplied by the run caller's input map (null when absent).
   *
   * @param {GraphNodeExecutionRequest<void>} request - Execution request carrying the workflow input values.
   * @return {GraphExecutionValues} The `value` output.
   */
  override execute(
    request: GraphNodeExecutionRequest<void>
  ): GraphExecutionValues {
    const inputs = request.inputs as unknown as
      | Record<string, unknown>
      | undefined;
    return { value: inputs?.["value"] ?? null };
  }

  /** Output feeding the value to one or more downstream targets. */
  @output({
    handle: "value",
    connectionRules: {
      allowMultiple: true,
    },
  })
  value!: unknown;
}
