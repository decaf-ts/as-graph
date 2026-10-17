/**
 * @module as-graph/nodes/agents/triggers/teams
 * @summary Teams channel trigger node declaration (SAA-836 M6).
 * @description Teams channel trigger: receives an inbound Teams conversation
 * message and carries the conversation binding (`threadId`) through the
 * graph so the matching Teams response node posts the reply to the same
 * conversation. The concrete mastra channel adapter is host-supplied through
 * the `@decaf-ts/as-graph/mastra` extension point (R2 — mastra's adapter
 * catalog is metadata-only, so the wrapper never constructs the adapter
 * itself and fails closed without the host surface). The node never executes
 * on the general engine; `core.agent.trigger.teams` requires the mastra
 * engine and fails closed otherwise (capability flag). Same size as the
 * existing trigger nodes (96×96) with the Teams supplier icon.
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

/** Inputs accepted by the Teams channel trigger (none — it is an entrypoint). */
export type TeamsChannelTriggerInput = Record<string, unknown>;

/** Outputs produced by the Teams channel trigger. */
export interface TeamsChannelTriggerOutput {
  message: unknown;
  sessionId: unknown;
  userId: unknown;
  threadId: unknown;
  resource: unknown;
}

/**
 * Teams channel trigger node: receives an inbound Teams conversation message
 * through the host-supplied mastra channel adapter surface.
 */
@node("core.agent.trigger.teams", {
  kind: "core.agent.trigger.teams",
  category: "Agent",
  icon: "ti-brand-teams",
  width: 96,
  height: 96,
  labels: ["agent", "ai", "trigger", "channel", "teams"],
  metadata: {
    title: "graph.node.agent.teams_trigger.name",
    description: "graph.node.agent.teams_trigger.description",
  },
})
@model()
export class TeamsChannelTriggerNode extends GraphNode<
  TeamsChannelTriggerInput,
  TeamsChannelTriggerOutput
> {
  /**
   * The general engine cannot run the channel trigger kind: the trigger
   * receives conversations through the host-supplied mastra channel adapter
   * surface only. Fails closed with {@link GRAPH_LOCAL_UNSUPPORTED_NODE_KIND}
   * so the general engine never fabricates a channel endpoint.
   *
   * @param {GraphNodeExecutionRequest<TeamsChannelTriggerInput>} _request - Unused; the channel trigger kind is mastra-only.
   * @return {GraphExecutionValues} Never returns.
   */
  override execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphNodeExecutionRequest<TeamsChannelTriggerInput>
  ): GraphExecutionValues {
    throw new GraphExecutionError(
      `Node kind 'core.agent.trigger.teams' requires the mastra engine, which the local backend does not provide`,
      GRAPH_LOCAL_UNSUPPORTED_NODE_KIND,
      { kind: "core.agent.trigger.teams", backend: "local" }
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

/** All built-in Teams channel trigger node constructors. */
export const GRAPH_AGENT_TEAMS_TRIGGER_NODES = [TeamsChannelTriggerNode] as const;
