/**
 * @module as-graph/nodes/flow-control/if
 * @summary If flow-control node declaration (DECAF-32 §22.2.2).
 * @description If — conditional branch. Evaluates a `ConditionExpression`
 * (§22.3) and routes the input to the `then` or `else` output. A graph-level
 * macro: the engine's planner recognises it as an ordinary executable node
 * (§5.7) but it has no built-in executor — downstream projects register
 * custom executors or compile it into composition APIs (§22.2.2).
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
 * If flow-control node: evaluates a condition and routes the input to the `then` or `else` output.
 */
@node("core.flow.if", {
  kind: "core.flow.if",
  category: "Flow Control",
  color: "#f59e0b",
  icon: "ti-arrows-split-2",
  width: 96,
  height: 96,
  labels: ["flow", "conditional", "branch"],
  metadata: {
    title: "If",
    description:
      "Conditional branch. Evaluates the configured condition and routes the input to the matching output.",
    condition: { op: "eq", left: { const: true }, right: { const: true } },
  },
})
@model()
export class IfFlowNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return { then: request.inputs["value"] ?? request.inputs };
  }

  @required()
  @uielement("textarea", {
    label: "Input value",
    placeholder: "Value to evaluate",
  })
  @input({ handle: "value" })
  value!: unknown;

  @required()
  @uielement("input", {
    label: "Then",
    placeholder: "Output when condition is true",
  })
  @output({ handle: "then" })
  then!: unknown;

  @required()
  @uielement("input", {
    label: "Else",
    placeholder: "Output when condition is false",
  })
  @output({ handle: "else" })
  else!: unknown;
}
