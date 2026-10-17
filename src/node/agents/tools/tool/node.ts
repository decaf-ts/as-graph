/**
 * @module as-graph/nodes/agents/tools/tool
 * @summary Mastra Tool node declaration (SAA-836 M3).
 * @description Tool node mirroring the mastra tool config. It connects only on
 * the agent `tools` zone (its `@connection()` port carries the `tools`
 * category) and, per R9, resolves its configuration into the mastra tool
 * resource on a real output port (config-only fallback remains valid).
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import { MASTRA_AGENT_ZONE } from "../../zones";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the tool node. */
export type AgentToolInput = Record<string, unknown>;

/** Outputs produced by the tool node. */
export interface AgentToolOutput {
  resource: unknown;
}

/**
 * Mastra Tool node: supplies one configured mastra tool to the agent's `tools`
 * zone.
 */
@node("core.agent.tool", {
  kind: "core.agent.tool",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "tool"],
  metadata: {
    title: "graph.node.agent.tool.name",
    description: "graph.node.agent.tool.description",
    shape: "rectangle",
  },
})
@model()
export class AgentToolNode extends GraphNode<AgentToolInput, AgentToolOutput> {
  /**
   * Resolves the configured tool into the mastra tool resource descriptor
   * returned on the `resource` output port (R9 preferred shape; the mastra
   * backend builds the live `Tool` from this descriptor).
   *
   * @param {GraphNodeExecutionRequest<AgentToolInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource` output value.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentToolInput>
  ): GraphExecutionValues {
    return {
      resource: {
        type: "mastra.tool",
        toolId: this.toolId,
        description: this.description,
        input: request.inputs,
      },
    };
  }

  /** The mastra tool id. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.tool.fields.toolId.label",
    placeholder: "graph.node.agent.tool.fields.toolId.placeholder",
    type: "text",
  })
  @input({ handle: "toolId", userControlled: true })
  toolId?: string;

  /** The human/model-facing tool description. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.tool.fields.description.label",
    type: "textarea",
  })
  @input({ handle: "description", userControlled: true })
  description?: string;

  /** Output carrying the resolved mastra tool resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `tools` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.tools, handle: "tool" })
  tool!: unknown;
}

/** All built-in tool node constructors. */
export const GRAPH_AGENT_TOOL_NODES = [AgentToolNode] as const;
