/**
 * @module as-graph/nodes/agents/triggers/slack
 * @summary Slack channel trigger node declaration (SAA-836 M6).
 * @description Slack channel trigger: receives an inbound Slack conversation
 * message and carries the conversation binding (`threadId`) through the
 * graph so the matching Slack response node posts the reply to the same
 * conversation. The concrete mastra channel adapter is host-supplied through
 * the `@decaf-ts/as-graph/mastra` extension point (R2 — mastra's adapter
 * catalog is metadata-only, so the wrapper never constructs the adapter
 * itself and fails closed without the host surface). The node never executes
 * on the general engine; `core.agent.trigger.slack` requires the mastra
 * engine and fails closed otherwise (capability flag). Same size as the
 * existing trigger nodes (96×96) with the Slack supplier icon.
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

/** Inputs accepted by the Slack channel trigger (none — it is an entrypoint). */
export type SlackChannelTriggerInput = Record<string, unknown>;

/** Outputs produced by the Slack channel trigger. */
export interface SlackChannelTriggerOutput {
  message: unknown;
  sessionId: unknown;
  userId: unknown;
  threadId: unknown;
  resource: unknown;
}

/**
 * Slack channel trigger node: receives an inbound Slack conversation message
 * through the host-supplied mastra channel adapter surface.
 */
@node("core.agent.trigger.slack", {
  kind: "core.agent.trigger.slack",
  category: "Agent",
  icon: "ti-brand-slack",
  width: 96,
  height: 96,
  labels: ["agent", "ai", "trigger", "channel", "slack"],
  metadata: {
    title: "graph.node.agent.slack_trigger.name",
    description: "graph.node.agent.slack_trigger.description",
  },
})
@model()
export class SlackChannelTriggerNode extends GraphNode<
  SlackChannelTriggerInput,
  SlackChannelTriggerOutput
> {
  /**
   * The general engine cannot run the channel trigger kind: the trigger
   * receives conversations through the host-supplied mastra channel adapter
   * surface only. Fails closed with {@link GRAPH_LOCAL_UNSUPPORTED_NODE_KIND}
   * so the general engine never fabricates a channel endpoint.
   *
   * @param {GraphNodeExecutionRequest<SlackChannelTriggerInput>} _request - Unused; the channel trigger kind is mastra-only.
   * @return {GraphExecutionValues} Never returns.
   */
  override execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphNodeExecutionRequest<SlackChannelTriggerInput>
  ): GraphExecutionValues {
    throw new GraphExecutionError(
      `Node kind 'core.agent.trigger.slack' requires the mastra engine, which the local backend does not provide`,
      GRAPH_LOCAL_UNSUPPORTED_NODE_KIND,
      { kind: "core.agent.trigger.slack", backend: "local" }
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

/** All built-in Slack channel trigger node constructors. */
export const GRAPH_AGENT_SLACK_TRIGGER_NODES = [SlackChannelTriggerNode] as const;
