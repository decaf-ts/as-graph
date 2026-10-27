/**
 * @module as-graph/mastra/MastraChannelResponse
 * @summary Run-scoped channel-response service and step handler for the
 * built-in channel response kinds (SAA-836 M6, re-homed by SAA-1547).
 * @description Builds the {@link MastraChannelNodeRuntime} `response` service
 * that the channel response node classes (`core.agent.response.slack`,
 * `core.agent.response.discord`, `core.agent.response.telegram`,
 * `core.agent.response.teams`) delegate to from their `execute()`, then binds
 * it to the single step adapter. The service posts the agent's reply back to
 * the platform conversation the graph received it from. The reply and
 * the conversation binding arrive on the node's `response` and `threadId`
 * inputs, so the response node posts to the same conversation the matching
 * channel trigger delivered; the configured binding is authoritative and a
 * wired binding may never override it (SAA-911 F5). The conversation context
 * is carried across turns by that binding plus the mastra memory thread the
 * agent is bound to.
 * The concrete mastra channel adapters are packaged in host-supplied packages,
 * so per R2 the delivery surface is a declared extension point: without one
 * the response fails closed with {@link GRAPH_MASTRA_CHANNEL_UNAVAILABLE}
 * instead of fabricating a delivered reply.
 */
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  GRAPH_MASTRA_CHANNEL_THREAD_MISMATCH,
  GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
  MASTRA_CHANNEL_PLATFORMS,
  type MastraChannelPlatform,
  type MastraChannelResponseDescriptor,
  type MastraNodeStepHandler,
} from "./types";
import type { MastraChannelNodeRuntime } from "./nodes/MastraNodeExecutionServices";
import { createMastraNodeStepHandler } from "./nodes/MastraNodeStepAdapter";
import { DiscordChannelResponseNode } from "./nodes/responses/discord/node";
import { SlackChannelResponseNode } from "./nodes/responses/slack/node";
import { TeamsChannelResponseNode } from "./nodes/responses/teams/node";
import { TelegramChannelResponseNode } from "./nodes/responses/telegram/node";

/** The node class for each built-in channel response kind. */
const CHANNEL_RESPONSE_NODE_CLASSES: Record<string, unknown> = {
  "core.agent.response.discord": DiscordChannelResponseNode,
  "core.agent.response.slack": SlackChannelResponseNode,
  "core.agent.response.teams": TeamsChannelResponseNode,
  "core.agent.response.telegram": TelegramChannelResponseNode,
};

/** The document node kind prefix every built-in channel response kind carries. */
export const GRAPH_MASTRA_CHANNEL_RESPONSE_KIND_PREFIX =
  "core.agent.response.";

/** Length cap for a wired thread-id override (SAA-911 F5): a conversation
 * binding is a platform identifier, not free-form upstream data; the cap
 * bounds what an upstream (potentially attacker-influenced) value can inject
 * into the delivery payload. */
export const GRAPH_MASTRA_CHANNEL_THREAD_ID_MAX_LENGTH = 512;

/**
 * The document node kind a channel response node declares for `platform`
 * (SAA-836 M6).
 *
 * @param platform - The channel platform.
 * @returns The response kind, e.g. `core.agent.response.slack`.
 */
export function mastraChannelResponseKindOf(
  platform: MastraChannelPlatform
): string {
  return `${GRAPH_MASTRA_CHANNEL_RESPONSE_KIND_PREFIX}${platform}`;
}

/** Every built-in channel response kind, in platform order. */
export const GRAPH_MASTRA_CHANNEL_RESPONSE_KINDS: readonly string[] =
  MASTRA_CHANNEL_PLATFORMS.map(mastraChannelResponseKindOf);

/** Options a {@link createMastraChannelResponseStepHandler} handler is built with. */
export interface MastraChannelResponseStepHandlerOptions {
  /**
   * Host factory posting the reply payload to the platform conversation bound
   * by the descriptor. When omitted, the response fails closed.
   */
  sendChannelResponse?: (
    descriptor: MastraChannelResponseDescriptor,
    payload: Record<string, unknown>
  ) => unknown | Promise<unknown>;
}

/**
 * Reads the {@link MastraChannelResponseDescriptor} a channel response node
 * resolves from its kind and parameters (R9 descriptor shape).
 *
 * @param node - The response node.
 * @param workflowId - The canonical workflow id the response belongs to.
 * @returns The channel response descriptor.
 * @throws {GraphExecutionError} when the node's kind names no built-in
 *   channel platform.
 */
export function mastraChannelResponseDescriptorOf(
  node: GraphNodeInstance,
  workflowId?: string
): MastraChannelResponseDescriptor {
  const platform = node.kind.slice(
    GRAPH_MASTRA_CHANNEL_RESPONSE_KIND_PREFIX.length
  );
  if (!(MASTRA_CHANNEL_PLATFORMS as readonly string[]).includes(platform)) {
    throw new GraphExecutionError(
      `Channel response node '${node.id}' declares unknown channel platform '${platform}'`,
      GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
      { nodeId: node.id, kind: node.kind }
    );
  }
  const parameters = node.parameters ?? {};
  const threadId = parameters["threadId"];
  return {
    platform: platform as MastraChannelPlatform,
    ...(typeof threadId === "string" && threadId.trim() !== ""
      ? { threadId }
      : {}),
    ...(workflowId ? { workflowId } : {}),
    nodeId: node.id,
  };
}

/**
 * Builds the run-scoped channel transport service used by response nodes. The
 * service owns the host delivery factory; the node class owns the declared
 * response/thread-binding semantics and output mapping.
 *
 * @param options - The handler options (the host delivery factory).
 * @returns The channel response runtime service.
 */
export function createMastraChannelResponseNodeRuntime(
  options: MastraChannelResponseStepHandlerOptions = {}
): MastraChannelNodeRuntime {
  return {
    trigger: async () => {
      throw new GraphExecutionError(
        "The channel response runtime does not execute channel trigger nodes",
        GRAPH_MASTRA_CHANNEL_UNAVAILABLE
      );
    },
    response: async (node, inputData) => {
      const response = inputData["response"];
      const wiredThreadId =
        typeof inputData["threadId"] === "string" &&
        inputData["threadId"].trim() !== ""
          ? inputData["threadId"]
          : undefined;
      const descriptor = mastraChannelResponseDescriptorOf(node);
      if (
        descriptor.threadId !== undefined &&
        wiredThreadId !== undefined &&
        wiredThreadId !== descriptor.threadId
      ) {
        throw new GraphExecutionError(
          `Channel response node '${node.id}' received a wired thread id that differs from its configured binding; the configured binding is authoritative and the override is refused (SAA-911 F5)`,
          GRAPH_MASTRA_CHANNEL_THREAD_MISMATCH,
          {
            nodeId: node.id,
            kind: node.kind,
            platform: descriptor.platform,
            configuredLength: descriptor.threadId.length,
            wiredLength: wiredThreadId.length,
          }
        );
      }
      const bound =
        descriptor.threadId !== undefined ? descriptor.threadId : wiredThreadId;
      if (
        descriptor.threadId === undefined &&
        wiredThreadId !== undefined &&
        wiredThreadId.length > GRAPH_MASTRA_CHANNEL_THREAD_ID_MAX_LENGTH
      ) {
        throw new GraphExecutionError(
          `Channel response node '${node.id}' received a wired thread id longer than ${GRAPH_MASTRA_CHANNEL_THREAD_ID_MAX_LENGTH} characters; the override is refused (SAA-911 F5)`,
          GRAPH_MASTRA_CHANNEL_THREAD_MISMATCH,
          { nodeId: node.id, kind: node.kind, platform: descriptor.platform }
        );
      }
      if (!options.sendChannelResponse) {
        throw new GraphExecutionError(
          `Channel response node '${node.id}' has no host mastra channel delivery surface configured`,
          GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
          { nodeId: node.id, kind: node.kind, platform: descriptor.platform }
        );
      }
      const payload = { response, threadId: bound ?? null };
      const posted = await options.sendChannelResponse(descriptor, payload);
      if (posted === undefined || posted === null) {
        throw new GraphExecutionError(
          `Channel response node '${node.id}': the host mastra channel delivery factory resolved no posted reply`,
          GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
          { nodeId: node.id, kind: node.kind, platform: descriptor.platform }
        );
      }
      return { resource: posted };
    },
  };
}

/**
 * Builds the {@link MastraNodeStepHandler} registered for one built-in
 * channel response kind through the single node-class adapter.
 *
 * @param kind - The channel response kind to translate.
 * @param options - The handler options (the host delivery factory).
 * @returns The channel response step handler.
 */
export function createMastraChannelResponseStepHandler(
  kind: string,
  options: MastraChannelResponseStepHandlerOptions = {}
): MastraNodeStepHandler {
  const nodeClass = CHANNEL_RESPONSE_NODE_CLASSES[kind];
  if (!nodeClass) {
    throw new GraphExecutionError(
      `No mastra channel response node class is registered for kind '${kind}'`,
      GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
      { kind }
    );
  }
  return createMastraNodeStepHandler(
    kind,
    nodeClass as never,
    { channel: createMastraChannelResponseNodeRuntime(options) }
  );
}

/**
 * Builds the {@link MastraNodeStepHandler} set for every built-in channel
 * response kind.
 *
 * @param options - The handler options (the host delivery factory).
 * @returns One handler per channel response kind.
 */
export function createMastraChannelResponseStepHandlers(
  options: MastraChannelResponseStepHandlerOptions = {}
): MastraNodeStepHandler[] {
  return GRAPH_MASTRA_CHANNEL_RESPONSE_KINDS.map((kind) =>
    createMastraChannelResponseStepHandler(kind, options)
  );
}
