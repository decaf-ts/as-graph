/**
 * @module as-graph/nodes/utility/return
 * @summary Return utility node declaration (DECAF-32 §22.2.2).
 * @description Return — defines and normalises the final workflow output.
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
 * Return utility node: defines and normalises the final workflow output.
 */
@node("core.flow.return", {
  kind: "core.flow.return",
  category: "Utility",
  color: "#0d9488",
  icon: "ti-arrow-back-up",
  width: 96,
  height: 96,
  labels: ["flow", "return", "output"],
  metadata: {
    title: "Return",
    description: "Normalises the input into the final workflow output object.",
    outputSchema: {},
  },
})
@model()
export class ReturnFlowNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return { result: request.inputs["value"] ?? request.inputs };
  }

  @required()
  @uielement("textarea", {
    label: "Input value",
    placeholder: "Value to normalise",
  })
  @input({ handle: "value" })
  value!: unknown;

  @required()
  @uielement("input", {
    label: "Returned output",
    placeholder: "Normalised output",
  })
  @output({ handle: "result" })
  result!: unknown;
}
