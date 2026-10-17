/**
 * @module as-graph/mastra/MastraVoiceStepHandler
 * @summary Mastra step handler for the `core.agent.voice` kind (SAA-836 M6).
 * @description Translates a voice node into a mastra step that resolves the
 * node's voice configuration descriptor — mirroring mastra's `VoiceConfig`
 * shape — and hands it to the host-supplied voice factory, which resolves the
 * live mastra voice surface (for example the wired agent's `getVoice()`). The
 * concrete `@mastra/voice-*` provider packages are not vendored, so per R2
 * the voice surface is a declared extension point: without one the node fails
 * closed with {@link GRAPH_MASTRA_VOICE_UNAVAILABLE} instead of fabricating a
 * voice capability.
 */
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  GRAPH_MASTRA_VOICE_UNAVAILABLE,
  type MastraNodeStepHandler,
  type MastraNodeStepOptions,
  type MastraVoiceConfigDescriptor,
} from "./types";

/** The document node kind the voice step handler translates. */
export const GRAPH_MASTRA_VOICE_KIND = "core.agent.voice";

/** Options a {@link createMastraVoiceStepHandler} handler is built with. */
export interface MastraVoiceStepHandlerOptions {
  /**
   * Host factory resolving the real mastra voice surface for the descriptor.
   * When omitted, the node fails closed.
   */
  resolveVoice?: (
    descriptor: MastraVoiceConfigDescriptor
  ) => unknown | Promise<unknown>;
}

/** The voice-model config shape a voice node carries per mastra's `VoiceConfig`. */
export interface MastraVoiceModelConfig {
  /** The model name the voice provider renders/listens with. */
  name?: string;
}

/**
 * Reads the {@link MastraVoiceConfigDescriptor} a voice node resolves from
 * its parameters (R9 descriptor shape, mirroring mastra's `VoiceConfig`).
 *
 * @param node - The voice node.
 * @param workflowId - The canonical workflow id the node belongs to.
 * @returns The voice configuration descriptor.
 */
export function mastraVoiceConfigDescriptorOf(
  node: GraphNodeInstance,
  workflowId?: string
): MastraVoiceConfigDescriptor {
  const parameters = node.parameters ?? {};
  const descriptor: MastraVoiceConfigDescriptor = {
    ...(typeof parameters["speaker"] === "string" &&
    (parameters["speaker"] as string).trim() !== ""
      ? { speaker: parameters["speaker"] as string }
      : {}),
    ...(workflowId ? { workflowId } : {}),
    nodeId: node.id,
  };
  for (const key of ["speechModel", "listeningModel"] as const) {
    const value = parameters[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const name = record["name"];
      if (typeof name === "string" && name.trim() !== "") {
        descriptor[key] = { name };
      }
    }
  }
  return descriptor;
}

/**
 * Builds the {@link MastraNodeStepHandler} registered for the
 * `core.agent.voice` kind. The step resolves the node's voice configuration
 * descriptor, delegates the live voice surface to the host factory, and
 * returns it on the `resource` output (R9 resource-output preferred). Without
 * a host factory the step fails closed — no voice capability is ever
 * fabricated.
 *
 * @param options - The handler options (the host voice factory).
 * @returns The voice step handler.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_VOICE_UNAVAILABLE} when no
 *   host factory is configured or it yields nothing.
 */
export function createMastraVoiceStepHandler(
  options: MastraVoiceStepHandlerOptions = {}
): MastraNodeStepHandler {
  return {
    kind: GRAPH_MASTRA_VOICE_KIND,
    createStep: (node: GraphNodeInstance, { stepId }: MastraNodeStepOptions) =>
      createStep({
        id: stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: { inputData?: unknown }) => {
          void args;
          const descriptor = mastraVoiceConfigDescriptorOf(node);
          if (!options.resolveVoice) {
            throw new GraphExecutionError(
              `Voice node '${node.id}' has no host mastra voice surface configured`,
              GRAPH_MASTRA_VOICE_UNAVAILABLE,
              { nodeId: node.id, kind: node.kind }
            );
          }
          const voice = await options.resolveVoice(descriptor);
          if (voice === undefined || voice === null) {
            throw new GraphExecutionError(
              `Voice node '${node.id}': the host mastra voice factory resolved no voice surface`,
              GRAPH_MASTRA_VOICE_UNAVAILABLE,
              { nodeId: node.id, kind: node.kind }
            );
          }
          return { resource: voice };
        },
      }),
  };
}
