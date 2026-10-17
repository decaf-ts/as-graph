/**
 * @module as-graph/nodes/agents/triggers/telegram
 * @summary Telegram channel trigger node declaration (SAA-836 M6).
 * @description Telegram channel trigger: receives an inbound Telegram conversation
 * message and carries the conversation binding (`threadId`) through the
 * graph so the matching Telegram response node posts the reply to the same
 * conversation. The concrete mastra channel adapter is host-supplied through
 * the `@decaf-ts/as-graph/mastra` extension point (R2 — mastra's adapter
 * catalog is metadata-only, so the wrapper never constructs the adapter
 * itself and fails closed without the host surface). The node never executes
 * on the general engine; `core.agent.trigger.telegram` requires the mastra
 * engine and fails closed otherwise (capability flag). Same size as the
 * existing trigger nodes (96×96) with the Telegram supplier icon.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import { GraphExecutionError } from "../../../../engine/errors/GraphExecutionError";
import { GRAPH_LOCAL_UNSUPPORTED_NODE_KIND } from "../../../../engine/constants";
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
   * The general engine cannot run the channel trigger kind: the trigger
   * receives conversations through the host-supplied mastra channel adapter
   * surface only. Fails closed with {@link GRAPH_LOCAL_UNSUPPORTED_NODE_KIND}
   * so the general engine never fabricates a channel endpoint.
   *
   * @param {GraphNodeExecutionRequest<TelegramChannelTriggerInput>} _request - Unused; the channel trigger kind is mastra-only.
   * @return {GraphExecutionValues} Never returns.
   */
  override execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphNodeExecutionRequest<TelegramChannelTriggerInput>
  ): GraphExecutionValues {
    throw new GraphExecutionError(
      `Node kind 'core.agent.trigger.telegram' requires the mastra engine, which the local backend does not provide`,
      GRAPH_LOCAL_UNSUPPORTED_NODE_KIND,
      { kind: "core.agent.trigger.telegram", backend: "local" }
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
