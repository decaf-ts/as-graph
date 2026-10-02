/**
 * @module as-graph/nodes/flow/break
 * @summary Break flow-control node declaration (DECAF-32 §22.2.2).
 * @description Break — breaks out of the enclosing loop (foreach/while/until).
 * When executed inside a loop body, the loop terminates early and the loop's
 * `completed`/`state` output carries the results collected so far. The Break
 * node's `execute` throws a `GraphBreakSignal` that the enclosing loop node
 * class catches. It declares **no output port**: it never forwards a value
 * downstream, it only terminates the loop.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphBreakSignal } from "../../../engine/errors/GraphBreakSignal";

/** Inputs accepted by the break node. */
export type BreakFlowInput = Record<string, unknown>;

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
    title: "graph.node.flow_control.break.name",
    description:
      "graph.node.flow_control.break.description",
  },
})
@model()
export class BreakFlowNode extends GraphNode<BreakFlowInput, void> {
  /**
   * Always throws a {@link GraphBreakSignal} carrying the `value` input; the
   * enclosing loop node catches it and terminates early. Never returns.
   *
   * @param {GraphNodeExecutionRequest<BreakFlowInput>} request - Execution request carrying the optional carried `value`.
   * @param {GraphExecutionContext} _context - Execution context (unused).
   * @return {GraphExecutionValues} Never returns; always throws.
   * @throws {GraphBreakSignal} With the `value` input as carried details.
   */
  override execute(
    request: GraphNodeExecutionRequest<BreakFlowInput>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: GraphExecutionContext
  ): GraphExecutionValues {
    throw new GraphBreakSignal(request.inputs["value"]);
  }

  /** Value carried on the break signal into the loop's collected results. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.break.fields.value.label",
    placeholder: "graph.node.flow_control.break.fields.value.placeholder",
    type: "textarea",
  })
  @input({ handle: "value" })
  value!: unknown;
}
