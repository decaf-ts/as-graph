/**
 * @module as-graph/nodes/agents/responses/discord
 * @summary Discord channel response node declaration (SAA-836 M6).
 * @description Discord channel response: posts the agent's reply back to the
 * Discord conversation the matching Discord channel trigger received it from. The
 * conversation binding arrives on the wired `threadId` input (falling back
 * to the configured binding), so the response posts to the same conversation
 * across turns and the context is carried by that binding plus the mastra
 * memory thread the agent is bound to. The concrete mastra channel delivery
 * surface is host-supplied through the `@decaf-ts/as-graph/mastra`
 * extension point (R2); the node never executes on the general engine and
 * fails closed otherwise (capability flag). Same size as the trigger nodes
 * (96×96) with the Discord supplier icon.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import { GraphExecutionError } from "../../../../engine/errors/GraphExecutionError";
import { GRAPH_LOCAL_UNSUPPORTED_NODE_KIND } from "../../../../engine/constants";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the Discord channel response. */
export type DiscordChannelResponseInput = Record<string, unknown>;

/** Outputs produced by the Discord channel response. */
export interface DiscordChannelResponseOutput {
  resource: unknown;
}

/**
 * Discord channel response node: posts the reply to the Discord conversation bound
 * by the wired thread binding through the host-supplied mastra channel
 * delivery surface.
 */
@node("core.agent.response.discord", {
  kind: "core.agent.response.discord",
  category: "Agent",
  icon: "ti-brand-discord",
  width: 96,
  height: 96,
  labels: ["agent", "ai", "response", "channel", "discord"],
  metadata: {
    title: "graph.node.agent.discord_response.name",
    description: "graph.node.agent.discord_response.description",
  },
})
@model()
export class DiscordChannelResponseNode extends GraphNode<
  DiscordChannelResponseInput,
  DiscordChannelResponseOutput
> {
  /**
   * The general engine cannot run the channel response kind: the reply is
   * delivered through the host-supplied mastra channel delivery surface
   * only. Fails closed with {@link GRAPH_LOCAL_UNSUPPORTED_NODE_KIND} so the
   * general engine never fabricates a delivered reply.
   *
   * @param {GraphNodeExecutionRequest<DiscordChannelResponseInput>} _request - Unused; the channel response kind is mastra-only.
   * @return {GraphExecutionValues} Never returns.
   */
  override execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphNodeExecutionRequest<DiscordChannelResponseInput>
  ): GraphExecutionValues {
    throw new GraphExecutionError(
      `Node kind 'core.agent.response.discord' requires the mastra engine, which the local backend does not provide`,
      GRAPH_LOCAL_UNSUPPORTED_NODE_KIND,
      { kind: "core.agent.response.discord", backend: "local" }
    );
  }

  /** The agent's reply posted back to the conversation. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.discord_response.fields.response.label",
    type: "textarea",
  })
  @input({ handle: "response" })
  response!: unknown;

  /** The conversation binding the reply is posted to. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.discord_response.fields.threadId.label",
    type: "text",
  })
  @input({ handle: "threadId", userControlled: true })
  threadId?: string;

  /** Output carrying the posted reply descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in Discord channel response node constructors. */
export const GRAPH_AGENT_DISCORD_RESPONSE_NODES = [DiscordChannelResponseNode] as const;
