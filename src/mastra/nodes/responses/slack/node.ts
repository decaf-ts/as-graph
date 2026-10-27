/**
 * @module as-graph/mastra/nodes/responses/slack
 * @summary Slack channel response node declaration (SAA-836 M6).
 * @description Slack channel response: posts the agent's reply back to the
 * Slack conversation the matching Slack channel trigger received it from. The
 * conversation binding arrives on the wired `threadId` input (falling back
 * to the configured binding), so the response posts to the same conversation
 * across turns and the context is carried by that binding plus the mastra
 * memory thread the agent is bound to. The concrete mastra channel delivery
 * surface is host-supplied through the `@decaf-ts/as-graph/mastra`
 * extension point (R2). The local engine rejects the kind through the
 * engine-requirement gate; on the Mastra engine the node's `execute()` is the
 * single implementation, invoked through the Mastra step adapter with the
 * run-scoped channel service. Same size as the trigger nodes (96×96) with the
 * Slack supplier icon.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
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

/** Inputs accepted by the Slack channel response. */
export type SlackChannelResponseInput = Record<string, unknown>;

/** Outputs produced by the Slack channel response. */
export interface SlackChannelResponseOutput {
  resource: unknown;
}

/**
 * Slack channel response node: posts the reply to the Slack conversation bound
 * by the response's configured thread binding — a wired thread binding may
 * never override it (SAA-911 F5) — through the host-supplied mastra channel
 * delivery surface.
 */
@node("core.agent.response.slack", {
  kind: "core.agent.response.slack",
  category: "Agent",
  icon: "ti-brand-slack",
  width: 96,
  height: 96,
  labels: ["agent", "ai", "response", "channel", "slack"],
  metadata: {
    title: "graph.node.agent.slack_response.name",
    description: "graph.node.agent.slack_response.description",
  },
})
@model()
export class SlackChannelResponseNode extends GraphNode<
  SlackChannelResponseInput,
  SlackChannelResponseOutput
> {
  /**
   * Executes the channel response through the run-scoped channel transport
   * service. The node owns the declared response semantics; the injected
   * service owns the host platform adapter. A missing transport fails closed
   * with a stable typed graph execution error.
   *
   * @param {GraphNodeExecutionRequest<SlackChannelResponseInput>} request - Execution request.
   * @return {Promise<GraphExecutionValues>} The channel response outputs.
   */
  override async execute(
    request: GraphNodeExecutionRequest<SlackChannelResponseInput>
  ): Promise<GraphExecutionValues> {
    const runtime = requireMastraNodeService(
      request,
      "channel",
      mastraServiceUnavailableCode("channel")
    );
    const mastra = mastraNodeRuntimeOf(request)!;
    return runtime.response(
      mastra.node,
      request.inputs,
      mastra.document,
      mastra.signal
    );
  }

  /** The agent's reply posted back to the conversation. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.slack_response.fields.response.label",
    type: "textarea",
  })
  @input({ handle: "response" })
  response!: unknown;

  /** The conversation binding the reply is posted to. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.slack_response.fields.threadId.label",
    type: "text",
  })
  @input({ handle: "threadId", userControlled: true })
  threadId?: string;

  /** Output carrying the posted reply descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in Slack channel response node constructors. */
export const GRAPH_AGENT_SLACK_RESPONSE_NODES = [SlackChannelResponseNode] as const;
