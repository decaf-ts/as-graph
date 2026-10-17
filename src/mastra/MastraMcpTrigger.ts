/**
 * @module as-graph/mastra/MastraMcpTrigger
 * @summary Mastra step handler for the `core.agent.trigger.mcp` kind
 * (SAA-836 M5).
 * @description Translates an MCP Server Trigger node into a mastra step that
 * resolves the trigger's MCP server descriptor and hands it to the
 * host-supplied server factory. The concrete mastra MCP server implementation
 * is packaged as `@mastra/mcp`, which as-graph does not vendor; per R2 the
 * server surface is therefore a declared extension point — the host factory
 * wraps the real server, and without one the trigger fails closed with
 * {@link GRAPH_MASTRA_MCP_UNAVAILABLE} instead of fabricating a served
 * endpoint.
 */
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  GRAPH_MASTRA_MCP_UNAVAILABLE,
  type MastraMcpServerDescriptor,
  type MastraNodeStepHandler,
  type MastraNodeStepOptions,
} from "./types";

/** The document node kind the MCP trigger handler translates. */
export const GRAPH_MASTRA_MCP_TRIGGER_KIND = "core.agent.trigger.mcp";

/** Options a {@link createMastraMcpTriggerStepHandler} handler is built with. */
export interface MastraMcpTriggerStepHandlerOptions {
  /**
   * Host factory building the real mastra MCP server surface for the
   * descriptor. When omitted, the trigger fails closed.
   */
  createMcpServer?: (
    descriptor: MastraMcpServerDescriptor
  ) => unknown | Promise<unknown>;
}

/**
 * Reads the {@link MastraMcpServerDescriptor} an MCP Server Trigger node
 * resolves from its parameters (R9 descriptor shape).
 *
 * @param node - The trigger node.
 * @param workflowId - The canonical workflow id the trigger belongs to.
 * @returns The MCP server descriptor.
 */
export function mastraMcpServerDescriptorOf(
  node: GraphNodeInstance,
  workflowId?: string
): MastraMcpServerDescriptor {
  const parameters = node.parameters ?? {};
  const transport = parameters["transport"];
  return {
    serverId: String(parameters["serverId"] ?? node.id),
    ...(typeof parameters["title"] === "string"
      ? { title: parameters["title"] as string }
      : {}),
    ...(typeof parameters["instructions"] === "string"
      ? { instructions: parameters["instructions"] as string }
      : {}),
    ...(transport === "http" || transport === "stdio"
      ? { transport }
      : {}),
    ...(workflowId ? { workflowId } : {}),
    nodeId: node.id,
  };
}

/**
 * Builds the {@link MastraNodeStepHandler} registered for the
 * `core.agent.trigger.mcp` kind. The step resolves the trigger's MCP server
 * descriptor, delegates the serving to the host factory, and returns the
 * server surface on the `resource` output. Without a host factory the step
 * fails closed — no endpoint is ever fabricated.
 *
 * @param options - The handler options (the host server factory).
 * @returns The MCP trigger step handler.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_MCP_UNAVAILABLE} when no
 *   host factory is configured or it yields nothing.
 */
export function createMastraMcpTriggerStepHandler(
  options: MastraMcpTriggerStepHandlerOptions = {}
): MastraNodeStepHandler {
  return {
    kind: GRAPH_MASTRA_MCP_TRIGGER_KIND,
    createStep: (node: GraphNodeInstance, { stepId }: MastraNodeStepOptions) =>
      createStep({
        id: stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: { inputData?: unknown }) => {
          void args;
          const descriptor = mastraMcpServerDescriptorOf(node);
          if (!options.createMcpServer) {
            throw new GraphExecutionError(
              `MCP trigger node '${node.id}' has no host mastra MCP server surface configured`,
              GRAPH_MASTRA_MCP_UNAVAILABLE,
              { nodeId: node.id, kind: node.kind }
            );
          }
          const server = await options.createMcpServer(descriptor);
          if (server === undefined || server === null) {
            throw new GraphExecutionError(
              `MCP trigger node '${node.id}': the host mastra MCP server factory resolved no server`,
              GRAPH_MASTRA_MCP_UNAVAILABLE,
              { nodeId: node.id, kind: node.kind }
            );
          }
          return { resource: server };
        },
      }),
  };
}
