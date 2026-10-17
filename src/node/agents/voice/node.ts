/**
 * @module as-graph/nodes/agents/voice
 * @summary Mastra Voice node declaration (SAA-836 M6).
 * @description Voice node: declares a mastra voice configuration (mastra's
 * `VoiceConfig` shape — speaker plus optional speech/listening model) and
 * resolves the live mastra voice surface through the host-supplied
 * `@decaf-ts/as-graph/mastra` extension point (R2 — the `@mastra/voice-*`
 * provider packages are not vendored, so the wrapper never constructs a
 * provider voice client itself and fails closed without the host surface,
 * for example the wired agent's `getVoice()`). The node never executes on
 * the general engine; `core.agent.voice` requires the mastra engine and
 * fails closed otherwise (capability flag). Rounded-square node with the
 * speaker icon.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { GRAPH_LOCAL_UNSUPPORTED_NODE_KIND } from "../../../engine/constants";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the voice node. */
export type AgentVoiceInput = Record<string, unknown>;

/** Outputs produced by the voice node. */
export interface AgentVoiceOutput {
  resource: unknown;
}

/**
 * Mastra Voice node: resolves the configured mastra voice surface (per the
 * `VoiceConfig` shape) through the host-supplied voice factory.
 */
@node("core.agent.voice", {
  kind: "core.agent.voice",
  category: "Agent",
  icon: "ti-volume-2",
  shape: "rounded",
  width: 96,
  height: 96,
  labels: ["agent", "ai", "voice", "speech"],
  metadata: {
    title: "graph.node.agent.voice.name",
    description: "graph.node.agent.voice.description",
  },
})
@model()
export class AgentVoiceNode extends GraphNode<AgentVoiceInput, AgentVoiceOutput> {
  /**
   * The general engine cannot run the voice kind: the live mastra voice
   * surface is resolved through the host-supplied voice factory only. Fails
   * closed with {@link GRAPH_LOCAL_UNSUPPORTED_NODE_KIND} so the general
   * engine never fabricates a voice capability.
   *
   * @param {GraphNodeExecutionRequest<AgentVoiceInput>} _request - Unused; the voice kind is mastra-only.
   * @return {GraphExecutionValues} Never returns.
   */
  override execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphNodeExecutionRequest<AgentVoiceInput>
  ): GraphExecutionValues {
    throw new GraphExecutionError(
      `Node kind 'core.agent.voice' requires the mastra engine, which the local backend does not provide`,
      GRAPH_LOCAL_UNSUPPORTED_NODE_KIND,
      { kind: "core.agent.voice", backend: "local" }
    );
  }

  /** Optional speaker/voice id the provider renders speech with. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.voice.fields.speaker.label",
    type: "text",
  })
  @input({ handle: "speaker", userControlled: true })
  speaker?: string;

  /** Optional speech (text-to-speech) model configuration. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.voice.fields.speechModel.label",
    type: "object",
  })
  @input({ handle: "speechModel", userControlled: true, type: "object" })
  speechModel?: Record<string, unknown>;

  /** Optional listening (speech-to-text) model configuration. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.voice.fields.listeningModel.label",
    type: "object",
  })
  @input({ handle: "listeningModel", userControlled: true, type: "object" })
  listeningModel?: Record<string, unknown>;

  /** Output carrying the resolved mastra voice surface (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in voice node constructors. */
export const GRAPH_AGENT_VOICE_NODES = [AgentVoiceNode] as const;
