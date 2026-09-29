/**
 * @module as-graph/nodes/flow-control/parallel
 * @summary Parallel flow-control node declaration (DECAF-32 §22.2.2).
 * @description Parallel — splits execution into concurrent branches.
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
 * Parallel flow-control node: splits execution into concurrent branches.
 */
@node("core.flow.parallel", {
  kind: "core.flow.parallel",
  category: "Flow Control",
  color: "#f59e0b",
  icon: "ti-arrows-vertical",
  width: 96,
  height: 96,
  labels: ["flow", "parallel", "concurrent"],
  metadata: {
    title: "Parallel",
    description:
      "Splits execution into concurrent branches. All branches run in parallel and outputs are collected.",
    branchCount: 2,
  },
})
@model()
export class ParallelFlowNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return { branches: [request.inputs["value"] ?? request.inputs] };
  }

  @required()
  @uielement("textarea", {
    label: "Input value",
    placeholder: "Value to fan out",
  })
  @input({ handle: "value" })
  value!: unknown;

  @required()
  @uielement("input", {
    label: "Branches",
    placeholder: "Collected branch outputs",
  })
  @output({ handle: "branches" })
  branches!: unknown[];
}
