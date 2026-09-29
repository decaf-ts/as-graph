/**
 * @module as-graph/nodes/boundary/input-value
 * @summary Workflow input value boundary node declaration.
 * @description Shared canvas node representing a workflow input value
 * (decorator id `graph-input-value-node`), moved from the for-angular
 * boundary nodes so both sides share the declaration. Reusable value node
 * whose single `value` output may feed multiple targets.
 */
import { model } from "@decaf-ts/decorator-validation";
import { output, node } from "../../shared/graph";
import { GraphNode } from "../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";

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
    title: "Workflow input value",
    description: "Reusable canvas value node representing a workflow input.",
  },
})
@model()
export class GraphInputValueNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return { value: request.inputs["value"] ?? null };
  }

  @output({
    handle: "value",
    connectionRules: {
      allowMultiple: true,
    },
  })
  value!: unknown;
}
