/**
 * @module as-graph/nodes/boundary/output
 * @summary Workflow output value boundary node declaration.
 * @description Terminal boundary node representing a workflow output value
 * (decorator id `graph-output-value-node`). As an output boundary node it
 * produces no downstream data (`OUTPUT = void`): it is a sink whose single
 * `value` input receives the workflow result. The engine captures the workflow
 * output from that input value (the canvas projects the `$workflow` boundary
 * edges onto this node's `value` input). Converted from the former
 * `core.flow.return` utility node so both workflow boundaries share the
 * simpler boundary rendering (no `@uielement` on the port).
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { input, node } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the workflow output value boundary node. */
export type GraphOutputValueInput = Record<string, unknown>;

/**
 * Workflow output value boundary node: receives the final workflow value on its
 * `value` input and produces no outputs.
 */
@node("graph-output-value-node", {
  kind: "result",
  category: "Boundary",
  color: "#0f766e",
  icon: "ti-circle-minus",
  width: 96,
  height: 96,
  labels: ["workflow", "output", "value"],
  metadata: {
    title: "graph.node.boundary.output.name",
    description: "graph.node.boundary.output.description",
  },
})
@model()
export class GraphOutputValueNode extends GraphNode<
  GraphOutputValueInput,
  void
> {
  /**
   * No-op sink: the engine captures the workflow output from the `value`
   * input before this node executes, so execution produces no outputs.
   *
   * @param {GraphNodeExecutionRequest<GraphOutputValueInput>} _request - Execution request (unused; the engine reads the `value` input).
   * @return {GraphExecutionValues} An empty output map.
   */
  override execute(
    request: GraphNodeExecutionRequest<GraphOutputValueInput>
  ): GraphExecutionValues {
    void request;
    return {};
  }

  /** Input receiving the final workflow result captured by the engine. */
  @required()
  @input({ handle: "value" })
  value!: unknown;
}
