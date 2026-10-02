/**
 * @module as-graph/nodes/utility/delay
 * @summary Delay utility node declaration (DECAF-32 §22.2.2).
 * @description Delay — pauses execution for a configured duration. The node
 * carries exactly one configuration property (`timeoutMs`), one input, and one
 * output; it always forwards its input unchanged (passthrough).
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the delay node. */
export type DelayFlowInput = Record<string, unknown>;

/** Outputs produced by the delay node. */
export interface DelayFlowOutput {
  value: unknown;
}

/**
 * Delay utility node: pauses execution for a configured duration.
 */
@node("core.flow.delay", {
  kind: "core.flow.delay",
  category: "Utility",
  color: "#0d9488",
  icon: "ti-clock-hour-4",
  width: 96,
  height: 96,
  labels: ["flow", "delay", "wait"],
  metadata: {
    title: "graph.node.utility.delay.name",
    description:
      "graph.node.utility.delay.description",
  },
})
@model()
export class DelayFlowNode extends GraphNode<DelayFlowInput, DelayFlowOutput> {
  /**
   * Passthrough implementation: the actual wait is enforced by the execution
   * engine/frame using the configured `timeoutMs`; this method simply
   * forwards its input unchanged.
   *
   * @param {GraphNodeExecutionRequest<DelayFlowInput>} request - Execution request carrying the `value` input.
   * @return {GraphExecutionValues} The unchanged input value under `value`.
   */
  override execute(
    request: GraphNodeExecutionRequest<DelayFlowInput>
  ): GraphExecutionValues {
    return { value: request.inputs["value"] ?? request.inputs };
  }

  /** Input value forwarded unchanged after the delay. */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Delay duration in milliseconds enforced around this node's execution. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.utility.delay.fields.timeoutMs.label",
    type: "number",
  })
  @input({ handle: "timeoutMs" })
  timeoutMs?: number;

  /** Output carrying the unchanged input value. */
  @required()
  @output({ handle: "value" })
  valueOut!: unknown;
}
