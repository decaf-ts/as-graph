/**
 * @module as-graph/nodes/flow-control/error-boundary
 * @summary Error-boundary flow-control node declaration (DECAF-32 §22.2.2).
 * @description Error boundary — try/catch/finally workflow behaviour.
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
 * Error-boundary flow-control node: try/catch/finally workflow behaviour.
 */
@node("core.flow.errorBoundary", {
  kind: "core.flow.errorBoundary",
  category: "Flow Control",
  color: "#f59e0b",
  icon: "ti-shield-check",
  width: 96,
  height: 96,
  labels: ["flow", "error", "try-catch"],
  metadata: {
    title: "Error boundary",
    description:
      "Wraps the input in a try/catch/finally. Emits the result on success, or the error on failure.",
    finally: false,
  },
})
@model()
export class ErrorBoundaryFlowNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return { result: request.inputs["value"] ?? request.inputs };
  }

  @required()
  @uielement("textarea", {
    label: "Input value",
    placeholder: "Value to guard",
  })
  @input({ handle: "value" })
  value!: unknown;

  @required()
  @uielement("input", { label: "Result", placeholder: "Output on success" })
  @output({ handle: "result" })
  result!: unknown;

  @required()
  @uielement("input", { label: "Error", placeholder: "Output on failure" })
  @output({ handle: "error" })
  error!: unknown;
}
