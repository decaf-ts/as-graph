/**
 * @module as-graph/nodes/flow-control/break
 * @summary Break flow-control node declaration (DECAF-32 §22.2.2).
 * @description Break — breaks out of the enclosing loop (foreach/while/until).
 * When executed inside a loop body, the loop terminates early and the loop's
 * `completed`/`state` output carries the results collected so far. The Break
 * node's static `execute` throws a `GraphBreakSignal` that the enclosing loop
 * node class catches.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../shared/graph";
import { GraphNode } from "../base";
import type { GraphExecutionContext } from "../../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";
import { GraphBreakSignal } from "../../engine/errors/GraphBreakSignal";

/**
 * Break flow-control node: breaks out of the enclosing loop by throwing a `GraphBreakSignal` the loop catches.
 */
@node("core.flow.break", {
  kind: "core.flow.break",
  category: "Flow Control",
  color: "#f59e0b",
  icon: "ti-square-arrow-right",
  width: 96,
  height: 96,
  labels: ["flow", "break", "loop", "control"],
  metadata: {
    title: "Break",
    description:
      "Breaks out of the enclosing loop. The loop terminates early and returns the results collected so far.",
  },
})
@model()
export class BreakFlowNode extends GraphNode {
  static override execute(
    request: GraphNodeExecutionRequest,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: GraphExecutionContext
  ): GraphExecutionValues {
    throw new GraphBreakSignal(request.inputs["value"]);
  }

  @required()
  @uielement("textarea", {
    label: "Value",
    placeholder: "Value to forward (collected as the last partial result)",
  })
  @input({ handle: "value" })
  value!: unknown;

  @required()
  @output({ handle: "broken" })
  broken!: unknown;
}
