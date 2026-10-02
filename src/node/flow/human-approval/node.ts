/**
 * @module as-graph/nodes/flow/human-approval
 * @summary Human-approval flow-control node declaration (DECAF-32 §22.2.2).
 * @description Human approval — suspends execution until a human approves
 * or rejects.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the human-approval node. */
export type HumanApprovalFlowInput = Record<string, unknown>;

/** Outputs produced by the human-approval node. */
export interface HumanApprovalFlowOutput {
  approved: unknown;
  rejected: unknown;
}

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
    title: "graph.node.flow_control.human_approval.name",
    description:
      "graph.node.flow_control.human_approval.description",
    approvers: [],
    timeoutMs: 86400000,
  },
})
@model()
export class HumanApprovalFlowNode extends GraphNode<
  HumanApprovalFlowInput,
  HumanApprovalFlowOutput
> {
  /**
   * Routes the `value` input to the `approved` or `rejected` output based on
   * the recorded approval decision.
   *
   * @param {GraphNodeExecutionRequest<HumanApprovalFlowInput>} request - Execution request carrying the `value` input.
   * @return {GraphExecutionValues} The routed value under `approved` (or `rejected` when explicitly declined).
   */
  override execute(
    request: GraphNodeExecutionRequest<HumanApprovalFlowInput>
  ): GraphExecutionValues {
    const value = request.inputs["value"] ?? request.inputs;
    return this.approved === false ? { rejected: value } : { approved: value };
  }

  /** Value routed to the approval/rejection output once the decision is recorded. */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Human-facing message shown while execution is suspended for approval. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.human_approval.fields.message.label",
    placeholder: "graph.node.flow_control.human_approval.fields.message.placeholder",
    type: "textarea",
  })
  @input({ handle: "message", userControlled: true })
  message?: string;

  /** Recorded decision; an explicit `false` routes to `rejected`, anything else to `approved`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.human_approval.fields.approved.label",
    type: "checkbox",
  })
  @input({ handle: "approved", userControlled: true })
  approved?: boolean;

  /** Output carrying the value when the approval is granted. */
  @output({ handle: "approved" })
  approvedOut!: unknown;

  /** Output carrying the value when the approval is rejected. */
  @output({ handle: "rejected" })
  rejectedOut!: unknown;
}
