/**
 * @module as-graph/nodes/agents/hooks/tool-deny
 * @summary Mastra tool-deny node declaration (SAA-836 M3).
 * @description Tool-deny node, usable inside a hook before-sub-flow: it produces
 * the mastra `beforeToolCall` verdict (`{ proceed: false, output }`) that denies
 * a tool call and supplies the value returned to the model in its place.
 */
import { model } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the tool-deny node. */
export type AgentToolDenyInput = Record<string, unknown>;

/** Outputs produced by the tool-deny node. */
export interface AgentToolDenyOutput {
  proceed: boolean;
  value: unknown;
  denied: boolean;
  reason: unknown;
}

/**
 * Mastra tool-deny node: denies a tool call from inside a hook before-sub-flow.
 */
@node("core.agent.toolDeny", {
  kind: "core.agent.toolDeny",
  category: "Agent",
  width: 112,
  height: 96,
  labels: ["agent", "ai", "hook", "deny"],
  metadata: {
    title: "graph.node.agent.tool_deny.name",
    description: "graph.node.agent.tool_deny.description",
    shape: "rectangle",
  },
})
@model()
export class AgentToolDenyNode extends GraphNode<
  AgentToolDenyInput,
  AgentToolDenyOutput
> {
  /**
   * Emits the deny verdict (`proceed: false`) and the replacement output.
   *
   * @param {GraphNodeExecutionRequest<AgentToolDenyInput>} request - Execution request.
   * @return {GraphExecutionValues} The deny verdict and replacement value.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentToolDenyInput>
  ): GraphExecutionValues {
    const value = request.inputs["value"];
    return {
      proceed: false,
      denied: true,
      reason: this.reason,
      value: this.replacement ?? value,
    };
  }

  /** The replacement value returned to the model in place of the tool output. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.tool_deny.fields.replacement.label",
    type: "textarea",
  })
  @input({ handle: "replacement", userControlled: true })
  replacement?: unknown;

  /** The denial reason (recorded, not returned to the model). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.tool_deny.fields.reason.label",
    type: "text",
  })
  @input({ handle: "reason", userControlled: true })
  reason?: string;

  /** Passthrough value (the hook context). */
  @input({ handle: "value" })
  value!: unknown;

  /** The mastra hook verdict boolean (`false` denies). */
  @output({ handle: "proceed" })
  proceedOut!: boolean;

  /** The replacement output value. */
  @output({ handle: "value" })
  valueOut!: unknown;

  /** Whether the tool call was denied. */
  @output({ handle: "denied" })
  deniedOut!: boolean;

  /** The denial reason. */
  @output({ handle: "reason" })
  reasonOut!: unknown;
}

/** All built-in tool-deny node constructors. */
export const GRAPH_AGENT_TOOL_DENY_NODES = [AgentToolDenyNode] as const;
