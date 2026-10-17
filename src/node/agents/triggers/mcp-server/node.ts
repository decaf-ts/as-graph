/**
 * @module as-graph/nodes/agents/triggers/mcp-server
 * @summary Mastra MCP Server Trigger node declaration (SAA-836 M5).
 * @description MCP Server Trigger: exposes the enclosing workflow as an MCP
 * server so external MCP clients can discover and invoke it (mastra's
 * `MCPServerBase` server surface). The concrete server implementation is
 * host-supplied through the `@decaf-ts/as-graph/mastra` extension point
 * (R2 — the `@mastra/mcp` package is not vendored, so the wrapper never
 * constructs the server itself and fails closed without the host surface).
 * The node never executes on the general engine; `core.agent.trigger.mcp`
 * requires the mastra engine and fails closed otherwise (capability flag).
 * Square (rectangular) node under the agent category (R4).
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import { GraphExecutionError } from "../../../../engine/errors/GraphExecutionError";
import { GRAPH_LOCAL_UNSUPPORTED_NODE_KIND } from "../../../../engine/constants";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the MCP Server Trigger (none — it is an entrypoint). */
export type McpServerTriggerInput = Record<string, unknown>;

/** Outputs produced by the MCP Server Trigger. */
export interface McpServerTriggerOutput {
  resource: unknown;
}

/**
 * Mastra MCP Server Trigger node: exposes the enclosing workflow as an MCP
 * server through the host-supplied mastra MCP server surface.
 */
@node("core.agent.trigger.mcp", {
  kind: "core.agent.trigger.mcp",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "trigger", "mcp", "server"],
  metadata: {
    title: "graph.node.agent.mcp_trigger.name",
    description: "graph.node.agent.mcp_trigger.description",
    shape: "rectangle",
  },
})
@model()
export class McpServerTriggerNode extends GraphNode<
  McpServerTriggerInput,
  McpServerTriggerOutput
> {
  /**
   * The general engine cannot run the MCP trigger kind: the trigger serves the
   * enclosing workflow through the host-supplied mastra MCP server surface
   * only. Fails closed with {@link GRAPH_LOCAL_UNSUPPORTED_NODE_KIND} so the
   * general engine never fabricates a served endpoint.
   *
   * @param {GraphNodeExecutionRequest<McpServerTriggerInput>} _request - Unused; the MCP trigger kind is mastra-only.
   * @return {GraphExecutionValues} Never returns.
   */
  override execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphNodeExecutionRequest<McpServerTriggerInput>
  ): GraphExecutionValues {
    throw new GraphExecutionError(
      `Node kind 'core.agent.trigger.mcp' requires the mastra engine, which the local backend does not provide`,
      GRAPH_LOCAL_UNSUPPORTED_NODE_KIND,
      { kind: "core.agent.trigger.mcp", backend: "local" }
    );
  }

  /** The unique MCP server id exposed to clients. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.mcp_trigger.fields.serverId.label",
    placeholder: "graph.node.agent.mcp_trigger.fields.serverId.placeholder",
    type: "text",
  })
  @input({ handle: "serverId", userControlled: true })
  serverId!: string;

  /** Optional display title for the MCP server. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.mcp_trigger.fields.title.label",
    type: "text",
  })
  @input({ handle: "title", userControlled: true })
  title?: string;

  /** Optional instructions describing how clients use the served workflow. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.mcp_trigger.fields.instructions.label",
    type: "textarea",
  })
  @input({ handle: "instructions", userControlled: true })
  instructions?: string;

  /** The transport the host server surface starts with (`http` or `stdio`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.mcp_trigger.fields.transport.label",
    type: "select",
  })
  @input({ handle: "transport", userControlled: true })
  transport?: "http" | "stdio";

  /** Output carrying the resolved MCP server descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in MCP Server Trigger node constructors. */
export const GRAPH_AGENT_MCP_TRIGGER_NODES = [McpServerTriggerNode] as const;
