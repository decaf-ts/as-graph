/**
 * @module as-graph/mastra/MastraVoiceStepHandler
 * @summary Run-scoped voice service and step handler for the `core.agent.voice`
 * kind (SAA-836 M6, re-homed by SAA-1547).
 * @description Builds the {@link MastraVoiceNodeRuntime} service that the voice
 * node delegates to from its `execute()`, then binds it to the single step
 * adapter. The service resolves the node's voice configuration descriptor —
 * mirroring mastra's `VoiceConfig` shape — and hands it to the host-supplied
 * voice factory, which resolves the live mastra voice surface (for example the
 * wired agent's `getVoice()`). The
 * concrete `@mastra/voice-*` provider packages are not vendored, so per R2
 * the voice surface is a declared extension point: without one the node fails
 * closed with {@link GRAPH_MASTRA_VOICE_UNAVAILABLE} instead of fabricating a
 * voice capability.
 */
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  GRAPH_MASTRA_VOICE_UNAVAILABLE,
  type MastraNodeStepHandler,
  type MastraVoiceConfigDescriptor,
} from "./types";
import type { MastraVoiceNodeRuntime } from "./nodes/MastraNodeExecutionServices";
import { createMastraNodeStepHandler } from "./nodes/MastraNodeStepAdapter";
import { AgentVoiceNode } from "./nodes/voice/node";

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
 * Builds the run-scoped voice service used by the voice node. The service owns
 * the host voice-provider resolution; the node class owns the declared voice
 * configuration descriptor.
 *
 * @param options - The handler options (the host voice factory).
 * @returns The voice node runtime service.
 */
export function createMastraVoiceNodeRuntime(
  options: MastraVoiceStepHandlerOptions = {}
): MastraVoiceNodeRuntime {
  return {
    execute: async (node) => {
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
  };
}

/**
 * Builds the {@link MastraNodeStepHandler} registered for the
 * `core.agent.voice` kind through the single node-class adapter.
 *
 * @param options - The handler options (the host voice factory).
 * @returns The voice step handler.
 */
export function createMastraVoiceStepHandler(
  options: MastraVoiceStepHandlerOptions = {}
): MastraNodeStepHandler {
  return createMastraNodeStepHandler(GRAPH_MASTRA_VOICE_KIND, AgentVoiceNode, {
    voice: createMastraVoiceNodeRuntime(options),
  });
}
