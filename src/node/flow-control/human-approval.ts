/**
 * @module as-graph/nodes/flow-control/human-approval
 * @summary Human-approval flow-control node declaration (DECAF-32 §22.2.2).
 * @description Human approval — suspends execution until a human approves
 * or rejects.
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
 * Human-approval flow-control node: suspends execution until a human approves or rejects.
 */
@node("core.flow.humanApproval", {
  kind: "core.flow.humanApproval",
  category: "Flow Control",
  color: "#f59e0b",
  icon: "ti-user-check",
  width: 96,
  height: 96,
  labels: ["flow", "approval", "suspend"],
  metadata: {
    title: "Human approval",
    description:
      "Suspends execution until a human approves or rejects. Emits the approved value or a rejection.",
    approvers: [],
    timeoutMs: 86400000,
  },
})
@model()
export class HumanApprovalFlowNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return { approved: request.inputs["value"] ?? request.inputs };
  }

  @required()
  @uielement("textarea", {
    label: "Input value",
    placeholder: "Value pending approval",
  })
  @input({ handle: "value" })
  value!: unknown;

  @required()
  @uielement("input", {
    label: "Approved",
    placeholder: "Output when approved",
  })
  @output({ handle: "approved" })
  approved!: unknown;

  @required()
  @uielement("input", {
    label: "Rejected",
    placeholder: "Output when rejected",
  })
  @output({ handle: "rejected" })
  rejected!: unknown;
}
