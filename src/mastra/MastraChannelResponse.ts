/**
 * @module as-graph/mastra/MastraChannelResponse
 * @summary Mastra step handler for the built-in channel response kinds
 * (SAA-836 M6).
 * @description Translates a channel response node (`core.agent.response.slack`,
 * `core.agent.response.discord`, `core.agent.response.telegram`,
 * `core.agent.response.teams`) into a mastra step that posts the agent's reply
 * back to the platform conversation the graph received it from. The reply and
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
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  GRAPH_MASTRA_CHANNEL_THREAD_MISMATCH,
  GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
  MASTRA_CHANNEL_PLATFORMS,
  type MastraChannelPlatform,
  type MastraChannelResponseDescriptor,
  type MastraNodeStepHandler,
  type MastraNodeStepOptions,
} from "./types";

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
 * Builds the {@link MastraNodeStepHandler} registered for one built-in
 * channel response kind. The step resolves the response's channel descriptor,
 * takes the reply from the wired `response` input, and binds the delivery to
 * the configured conversation binding; a wired `threadId` is honored only
 * when it is the sole binding known — it never overrides the configured
 * binding, and an override attempt (or an overlong wired value) fails closed
 * (SAA-911 F5). Delivery is delegated to the host factory, and the posted
 * reply descriptor is returned on the `resource` output. Without a host
 * factory the step fails closed — no reply is ever fabricated as delivered.
 *
 * @param kind - The channel response kind to translate.
 * @param options - The handler options (the host delivery factory).
 * @returns The channel response step handler.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_CHANNEL_UNAVAILABLE} when
 *   no host factory is configured or it yields nothing.
 */
export function createMastraChannelResponseStepHandler(
  kind: string,
  options: MastraChannelResponseStepHandlerOptions = {}
): MastraNodeStepHandler {
  return {
    kind,
    createStep: (node: GraphNodeInstance, { stepId }: MastraNodeStepOptions) =>
      createStep({
        id: stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: { inputData?: unknown }) => {
          const inputData =
            args.inputData && typeof args.inputData === "object"
              ? (args.inputData as Record<string, unknown>)
              : {};
          const response = inputData["response"];
          const wiredThreadId =
            typeof inputData["threadId"] === "string" &&
            inputData["threadId"].trim() !== ""
              ? inputData["threadId"]
              : undefined;
          const descriptor = mastraChannelResponseDescriptorOf(node);
          // SAA-911 F5: the configured binding is authoritative. A wired
          // `threadId` is upstream data (the matching trigger's binding when
          // the graph wires it straight through, but potentially
          // attacker-influenced output when it crosses another step), so it
          // may only be delivered when it either is the only binding known or
          // exactly matches the configured one — an override attempt fails
          // closed instead of silently redirecting the reply to another
          // conversation thread. The error details carry lengths only; the
          // attacker-influenced value is never echoed back.
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
            descriptor.threadId !== undefined
              ? descriptor.threadId
              : wiredThreadId;
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
      }),
  };
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
