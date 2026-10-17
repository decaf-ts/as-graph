/**
 * @module as-graph/mastra/MastraChannelTrigger
 * @summary Mastra step handler for the built-in channel trigger kinds
 * (SAA-836 M6).
 * @description Translates a channel trigger node (`core.agent.trigger.slack`,
 * `core.agent.trigger.discord`, `core.agent.trigger.telegram`,
 * `core.agent.trigger.teams`) into a mastra step that resolves the trigger's
 * channel descriptor, delegates the platform surface to the host-supplied
 * adapter factory, and forwards the inbound conversation payload carried by
 * the run input onto the trigger's outputs. The concrete mastra channel
 * adapters (`AgentChannels` adapters) are packaged in host-supplied packages —
 * mastra's adapter catalog is metadata-only — so per R2 the adapter surface is
 * a declared extension point: without one the trigger fails closed with
 * {@link GRAPH_MASTRA_CHANNEL_UNAVAILABLE} instead of fabricating a channel
 * endpoint.
 */
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
  MASTRA_CHANNEL_PLATFORMS,
  type MastraChannelPlatform,
  type MastraChannelTriggerDescriptor,
  type MastraNodeStepHandler,
  type MastraNodeStepOptions,
} from "./types";

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
 * Builds the {@link MastraNodeStepHandler} registered for one built-in
 * channel trigger kind. The step resolves the trigger's channel descriptor,
 * delegates the platform adapter surface to the host factory, and forwards
 * the inbound conversation payload — `message`, `sessionId`, `userId`,
 * `threadId` — from the run input onto the trigger's outputs so a wired
 * agent receives the prompt and the conversation binding. Without a host
 * factory the step fails closed — no channel endpoint is ever fabricated.
 *
 * @param kind - The channel trigger kind to translate.
 * @param options - The handler options (the host adapter factory).
 * @returns The channel trigger step handler.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_CHANNEL_UNAVAILABLE} when
 *   no host factory is configured or it yields nothing.
 */
export function createMastraChannelTriggerStepHandler(
  kind: string,
  options: MastraChannelTriggerStepHandlerOptions = {}
): MastraNodeStepHandler {
  return {
    kind,
    createStep: (node: GraphNodeInstance, { stepId }: MastraNodeStepOptions) =>
      createStep({
        id: stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: { inputData?: unknown }) => {
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
          const inputData =
            args.inputData && typeof args.inputData === "object"
              ? (args.inputData as Record<string, unknown>)
              : {};
          return {
            message: inputData["message"] ?? null,
            sessionId: inputData["sessionId"] ?? null,
            userId: inputData["userId"] ?? null,
            threadId: inputData["threadId"] ?? descriptor.threadId ?? null,
            resource: adapter,
          };
        },
      }),
  };
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
