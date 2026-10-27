/**
 * @module as-graph/mastra/nodes/voice
 * @summary Mastra Voice node declaration (SAA-836 M6).
 * @description Voice node: declares a mastra voice configuration (mastra's
 * `VoiceConfig` shape — speaker plus optional speech/listening model) and
 * resolves the live mastra voice surface through the host-supplied
 * `@decaf-ts/as-graph/mastra` extension point (R2 — the `@mastra/voice-*`
 * provider packages are not vendored, so the wrapper never constructs a
 * provider voice client itself and fails closed without the host surface,
 * for example the wired agent's `getVoice()`). The local engine rejects
 * `core.agent.voice` through the engine-requirement gate; on the Mastra
 * engine the node's `execute()` is the single implementation, invoked through
 * the Mastra step adapter with the run-scoped voice service. Rounded-square
 * node with the speaker icon.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../../node/base";
import {
  mastraNodeRuntimeOf,
  mastraServiceUnavailableCode,
  requireMastraNodeService,
} from "../MastraNodeExecutionServices";
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
   * Resolves the configured voice surface through the run-scoped voice
   * service. The node owns the declared voice configuration shape; the
   * injected service owns the host provider surface. A missing service fails
   * closed with `GRAPH_MASTRA_VOICE_UNAVAILABLE`.
   *
   * @param {GraphNodeExecutionRequest<AgentVoiceInput>} request - Execution request.
   * @return {Promise<GraphExecutionValues>} The `resource` voice output.
   */
  override async execute(
    request: GraphNodeExecutionRequest<AgentVoiceInput>
  ): Promise<GraphExecutionValues> {
    const runtime = requireMastraNodeService(
      request,
      "voice",
      mastraServiceUnavailableCode("voice")
    );
    const mastra = mastraNodeRuntimeOf(request)!;
    return runtime.execute(
      mastra.node,
      request.inputs,
      mastra.document,
      mastra.signal
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
