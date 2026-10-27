/**
 * @module as-graph/mastra/nodes/triggers/mcp-server
 * @summary Mastra MCP Server Trigger node declaration (SAA-836 M5).
 * @description MCP Server Trigger: exposes the enclosing workflow as an MCP
 * server so external MCP clients can discover and invoke it (mastra's
 * `MCPServerBase` server surface). The concrete server implementation is
 * host-supplied through the `@decaf-ts/as-graph/mastra` extension point
 * (R2 — the `@mastra/mcp` package is not vendored, so the wrapper never
 * constructs the server itself and fails closed without the host surface).
 * The local engine rejects `core.agent.trigger.mcp` through the
 * engine-requirement gate; on the Mastra engine the node's `execute()` is the
 * single implementation, invoked through the Mastra step adapter with the
 * run-scoped MCP service. Square (rectangular) node under the agent category
 * (R4).
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../../node/base";
import {
  mastraNodeRuntimeOf,
  mastraServiceUnavailableCode,
  requireMastraNodeService,
} from "../../MastraNodeExecutionServices";
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
   * Executes the MCP trigger through the run-scoped MCP server service. The
   * node owns the declared MCP descriptor semantics; the injected service owns
   * the host MCP server and delivery guard. A missing service fails closed
   * with a stable typed graph execution error.
   *
   * @param {GraphNodeExecutionRequest<McpServerTriggerInput>} request - Execution request.
   * @return {Promise<GraphExecutionValues>} The MCP server resource output.
   */
  override async execute(
    request: GraphNodeExecutionRequest<McpServerTriggerInput>
  ): Promise<GraphExecutionValues> {
    const runtime = requireMastraNodeService(
      request,
      "mcp",
      mastraServiceUnavailableCode("mcp")
    );
    const mastra = mastraNodeRuntimeOf(request)!;
    return runtime.execute(
      mastra.node,
      request.inputs,
      mastra.document,
      mastra.signal
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

  /**
   * The C6 delivery-authentication scheme clients must use (`token` or
   * `hmac`). Defaults to `token`.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.mcp_trigger.fields.authMode.label",
    type: "select",
  })
  @input({ handle: "authMode", userControlled: true })
  authMode?: "token" | "hmac";

  /**
   * Credential reference naming the `MASTRA_*` environment variable that
   * carries the delivery secret (never a plain secret). Omit to let the run
   * generate a scoped secret the host publishes to clients.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.mcp_trigger.fields.authCredentialRef.label",
    type: "object",
  })
  @input({ handle: "authCredentialRef", userControlled: true, type: "object" })
  authCredentialRef?: Record<string, unknown>;

  /** Ceiling on concurrent pending deliveries (default 256). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.mcp_trigger.fields.pendingCap.label",
    type: "number",
  })
  @input({ handle: "pendingCap", userControlled: true })
  pendingCap?: number;

  /** Ceiling (ms) a pending delivery may stay open (default 60000). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.mcp_trigger.fields.pendingTimeoutMs.label",
    type: "number",
  })
  @input({ handle: "pendingTimeoutMs", userControlled: true })
  pendingTimeoutMs?: number;

  /** Output carrying the resolved MCP server descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in MCP Server Trigger node constructors. */
export const GRAPH_AGENT_MCP_TRIGGER_NODES = [McpServerTriggerNode] as const;
