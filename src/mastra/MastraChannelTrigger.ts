/**
 * @module as-graph/mastra/MastraChannelTrigger
 * @summary Run-scoped channel-trigger service and step handler for the built-in
 * channel trigger kinds (SAA-836 M6, re-homed by SAA-1547).
 * @description Builds the {@link MastraChannelNodeRuntime} `trigger` service
 * that the channel trigger node classes (`core.agent.trigger.slack`,
 * `core.agent.trigger.discord`, `core.agent.trigger.telegram`,
 * `core.agent.trigger.teams`) delegate to from their `execute()`, then binds
 * it to the single step adapter. The service resolves the trigger's channel
 * descriptor, delegates the platform surface to the host-supplied adapter
 * factory, and forwards the inbound conversation payload carried by the run
 * input onto the trigger's outputs. The concrete mastra channel
 * adapters (`AgentChannels` adapters) are packaged in host-supplied packages —
 * mastra's adapter catalog is metadata-only — so per R2 the adapter surface is
 * a declared extension point: without one the trigger fails closed with
 * {@link GRAPH_MASTRA_CHANNEL_UNAVAILABLE} instead of fabricating a channel
 * endpoint.
 */
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
  MASTRA_CHANNEL_PLATFORMS,
  type MastraChannelPlatform,
  type MastraChannelTriggerDescriptor,
  type MastraNodeStepHandler,
} from "./types";
import type { MastraChannelNodeRuntime } from "./nodes/MastraNodeExecutionServices";
import { createMastraNodeStepHandler } from "./nodes/MastraNodeStepAdapter";
import { DiscordChannelTriggerNode } from "./nodes/triggers/discord/node";
import { SlackChannelTriggerNode } from "./nodes/triggers/slack/node";
import { TeamsChannelTriggerNode } from "./nodes/triggers/teams/node";
import { TelegramChannelTriggerNode } from "./nodes/triggers/telegram/node";

/** The node class for each built-in channel trigger kind. */
const CHANNEL_TRIGGER_NODE_CLASSES: Record<string, unknown> = {
  "core.agent.trigger.discord": DiscordChannelTriggerNode,
  "core.agent.trigger.slack": SlackChannelTriggerNode,
  "core.agent.trigger.teams": TeamsChannelTriggerNode,
  "core.agent.trigger.telegram": TelegramChannelTriggerNode,
};

/** The document node kind prefix every built-in channel trigger kind carries. */
export const GRAPH_MASTRA_CHANNEL_TRIGGER_KIND_PREFIX =
  "core.agent.trigger.";

/**
 * The document node kind a channel trigger node declares for `platform`
 * (SAA-836 M6).
 *
 * @param platform - The channel platform.
 * @returns The trigger kind, e.g. `core.agent.trigger.slack`.
 */
export function mastraChannelTriggerKindOf(
  platform: MastraChannelPlatform
): string {
  return `${GRAPH_MASTRA_CHANNEL_TRIGGER_KIND_PREFIX}${platform}`;
}

/** Every built-in channel trigger kind, in platform order. */
export const GRAPH_MASTRA_CHANNEL_TRIGGER_KINDS: readonly string[] =
  MASTRA_CHANNEL_PLATFORMS.map(mastraChannelTriggerKindOf);

/** Options a {@link createMastraChannelTriggerStepHandler} handler is built with. */
export interface MastraChannelTriggerStepHandlerOptions {
  /**
   * Host factory building the real mastra channel adapter surface for the
   * descriptor. When omitted, the trigger fails closed.
   */
  resolveChannelAdapter?: (
    descriptor: MastraChannelTriggerDescriptor
  ) => unknown | Promise<unknown>;
}

/**
 * Reads the {@link MastraChannelTriggerDescriptor} a channel trigger node
 * resolves from its kind and parameters (R9 descriptor shape).
 *
 * @param node - The trigger node.
 * @param workflowId - The canonical workflow id the trigger belongs to.
 * @returns The channel trigger descriptor.
 * @throws {GraphExecutionError} when the node's kind names no built-in
 *   channel platform.
 */
export function mastraChannelTriggerDescriptorOf(
  node: GraphNodeInstance,
  workflowId?: string
): MastraChannelTriggerDescriptor {
  const platform = node.kind.slice(
    GRAPH_MASTRA_CHANNEL_TRIGGER_KIND_PREFIX.length
  );
  if (!(MASTRA_CHANNEL_PLATFORMS as readonly string[]).includes(platform)) {
    throw new GraphExecutionError(
      `Channel trigger node '${node.id}' declares unknown channel platform '${platform}'`,
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
 * Builds the run-scoped channel transport service used by trigger nodes. The
 * service owns the host platform adapter lookup; the node class owns the
 * declared trigger semantics and output mapping.
 *
 * @param options - The handler options (the host adapter factory).
 * @returns The channel trigger runtime service.
 */
export function createMastraChannelTriggerNodeRuntime(
  options: MastraChannelTriggerStepHandlerOptions = {}
): MastraChannelNodeRuntime {
  return {
    trigger: async (node, inputData) => {
      const descriptor = mastraChannelTriggerDescriptorOf(node);
      if (!options.resolveChannelAdapter) {
        throw new GraphExecutionError(
          `Channel trigger node '${node.id}' has no host mastra channel adapter surface configured`,
          GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
          { nodeId: node.id, kind: node.kind, platform: descriptor.platform }
        );
      }
      const adapter = await options.resolveChannelAdapter(descriptor);
      if (adapter === undefined || adapter === null) {
        throw new GraphExecutionError(
          `Channel trigger node '${node.id}': the host mastra channel adapter factory resolved no adapter`,
          GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
          { nodeId: node.id, kind: node.kind, platform: descriptor.platform }
        );
      }
      return {
        message: inputData["message"] ?? null,
        sessionId: inputData["sessionId"] ?? null,
        userId: inputData["userId"] ?? null,
        threadId: inputData["threadId"] ?? descriptor.threadId ?? null,
        resource: adapter,
      };
    },
    response: async () => {
      throw new GraphExecutionError(
        "The channel trigger runtime does not execute channel response nodes",
        GRAPH_MASTRA_CHANNEL_UNAVAILABLE
      );
    },
  };
}

/**
 * Builds the {@link MastraNodeStepHandler} registered for one built-in
 * channel trigger kind through the single node-class adapter.
 *
 * @param kind - The channel trigger kind to translate.
 * @param options - The handler options (the host adapter factory).
 * @returns The channel trigger step handler.
 */
export function createMastraChannelTriggerStepHandler(
  kind: string,
  options: MastraChannelTriggerStepHandlerOptions = {}
): MastraNodeStepHandler {
  const nodeClass = CHANNEL_TRIGGER_NODE_CLASSES[kind];
  if (!nodeClass) {
    throw new GraphExecutionError(
      `No mastra channel trigger node class is registered for kind '${kind}'`,
      GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
      { kind }
    );
  }
  return createMastraNodeStepHandler(
    kind,
    nodeClass as never,
    { channel: createMastraChannelTriggerNodeRuntime(options) }
  );
}

/**
 * Builds the {@link MastraNodeStepHandler} set for every built-in channel
 * trigger kind.
 *
 * @param options - The handler options (the host adapter factory).
 * @returns One handler per channel trigger kind.
 */
export function createMastraChannelTriggerStepHandlers(
  options: MastraChannelTriggerStepHandlerOptions = {}
): MastraNodeStepHandler[] {
  return GRAPH_MASTRA_CHANNEL_TRIGGER_KINDS.map((kind) =>
    createMastraChannelTriggerStepHandler(kind, options)
  );
}
