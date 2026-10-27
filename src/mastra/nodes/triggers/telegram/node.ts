/**
 * @module as-graph/mastra/nodes/triggers/telegram
 * @summary Telegram channel trigger node declaration (SAA-836 M6).
 * @description Telegram channel trigger: receives an inbound Telegram conversation
 * message and carries the conversation binding (`threadId`) through the
 * graph so the matching Telegram response node posts the reply to the same
 * conversation. The concrete mastra channel adapter is host-supplied through
 * the `@decaf-ts/as-graph/mastra` extension point (R2 — mastra's adapter
 * catalog is metadata-only, so the wrapper never constructs the adapter
 * itself and fails closed without the host surface). The local engine rejects
 * `core.agent.trigger.telegram` through the engine-requirement gate; on the
 * Mastra engine the node's `execute()` is the single implementation, invoked
 * through the Mastra step adapter with the run-scoped channel service. Same
 * size as the existing trigger nodes (96×96) with the Telegram supplier icon.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { node, output } from "../../../../shared/graph";
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

/** Inputs accepted by the Telegram channel trigger (none — it is an entrypoint). */
export type TelegramChannelTriggerInput = Record<string, unknown>;

/** Outputs produced by the Telegram channel trigger. */
export interface TelegramChannelTriggerOutput {
  message: unknown;
  sessionId: unknown;
  userId: unknown;
  threadId: unknown;
  resource: unknown;
}

/**
 * Telegram channel trigger node: receives an inbound Telegram conversation message
 * through the host-supplied mastra channel adapter surface.
 */
@node("core.agent.trigger.telegram", {
  kind: "core.agent.trigger.telegram",
  category: "Agent",
  icon: "ti-brand-telegram",
  width: 96,
  height: 96,
  labels: ["agent", "ai", "trigger", "channel", "telegram"],
  metadata: {
    title: "graph.node.agent.telegram_trigger.name",
    description: "graph.node.agent.telegram_trigger.description",
  },
})
@model()
export class TelegramChannelTriggerNode extends GraphNode<
  TelegramChannelTriggerInput,
  TelegramChannelTriggerOutput
> {
  /**
   * Executes the channel trigger through the run-scoped channel transport
   * service. The node owns the declared trigger semantics; the injected
   * service owns the host platform adapter. A missing transport fails closed
   * with a stable typed graph execution error.
   *
   * @param {GraphNodeExecutionRequest<TelegramChannelTriggerInput>} request - Execution request.
   * @return {Promise<GraphExecutionValues>} The channel trigger outputs.
   */
  override async execute(
    request: GraphNodeExecutionRequest<TelegramChannelTriggerInput>
  ): Promise<GraphExecutionValues> {
    const runtime = requireMastraNodeService(
      request,
      "channel",
      mastraServiceUnavailableCode("channel")
    );
    const mastra = mastraNodeRuntimeOf(request)!;
    return runtime.trigger(
      mastra.node,
      request.inputs,
      mastra.document,
      mastra.signal
    );
  }

  /** Output carrying the inbound conversation message. */
  @required()
  @output({ handle: "message" })
  message!: unknown;

  /** Output carrying the conversation session identifier. */
  @required()
  @output({ handle: "sessionId" })
  sessionId!: unknown;

  /** Output carrying the sender's user identifier. */
  @required()
  @output({ handle: "userId" })
  userId!: unknown;

  /** Output carrying the conversation thread binding. */
  @required()
  @output({ handle: "threadId" })
  threadId!: unknown;

  /** Output carrying the resolved mastra channel adapter surface (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in Telegram channel trigger node constructors. */
export const GRAPH_AGENT_TELEGRAM_TRIGGER_NODES = [TelegramChannelTriggerNode] as const;
