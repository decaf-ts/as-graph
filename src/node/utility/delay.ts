/**
 * @module as-graph/nodes/utility/delay
 * @summary Delay utility node declaration (DECAF-32 §22.2.2).
 * @description Delay — pauses execution for a configured duration.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../shared/graph";
import { GraphNode } from "../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";

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
    title: "Delay",
    description:
      "Pauses execution for the configured duration (in milliseconds), then forwards the input unchanged.",
    durationMs: 1000,
  },
})
@model()
export class DelayFlowNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return { valueOut: request.inputs["value"] ?? request.inputs };
  }

  @required()
  @uielement("textarea", {
    label: "Input value",
    placeholder: "Value to forward after delay",
  })
  @input({ handle: "value" })
  value!: unknown;

  @required()
  @uielement("input", { label: "Output value", placeholder: "Forwarded value" })
  @output({ handle: "value" })
  valueOut!: unknown;
}
