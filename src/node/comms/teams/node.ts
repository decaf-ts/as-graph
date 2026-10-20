/**
 * @module as-graph/nodes/comms/teams
 * @summary Microsoft Teams Comms node declaration (Stage 3b; `core.comms.teams`).
 * @description Microsoft Teams — incoming-webhook posts and Graph channel
 * messaging through the Decaf `TeamsNodeService`. The `teams` credential (resolved
 * through the ctx-bound node credential resolver) is a bare token or a
 * JSON object; a `token` field authorizes Graph operations and a `webhookUrl`
 * field authorizes webhook posts. `sendWebhook` requires `text` (falling back
 * to the `value` input) and posts via the webhook URL; `sendChannelMessage`
 * requires `teamId`, `channelId`, and `content` and posts via the Graph API
 * with a `token`; `listTeams` and `listChannels` (which requires `teamId`)
 * only need Graph access. An unknown `operation` silently falls back to
 * `sendWebhook`. A throwaway `TeamsNodeService` is initialized per execution and
 * shut down in a `finally` block.
 */
import { model } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { TeamsNodeService } from "@decaf-ts/integrations/comms/teams";
import {
  asNumber,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialValue } from "../../credentials";

/** Operation the node performs against Teams (webhook or Graph). */
export type TeamsOperation =
  | "sendWebhook"
  | "sendChannelMessage"
  | "listTeams"
  | "listChannels";

/** Inputs accepted by the Teams node. */
export type TeamsNodeInput = Record<string, unknown>;

/** Outputs produced by the Teams node. */
export interface TeamsNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
}

/** Supported operations; unknown configured values fall back to `sendWebhook`. */
const OPERATIONS: TeamsOperation[] = [
  "sendWebhook",
  "sendChannelMessage",
  "listTeams",
  "listChannels",
];

/**
 * Teams node (`core.comms.teams`): webhook posts and Graph channel messaging
 * through the Decaf `TeamsNodeService`.
 */
@node("core.comms.teams", {
  kind: "core.comms.teams",
  category: "Comms",
  color: "#6264a7",
  icon: "ti-brand-teams",
  width: 96,
  height: 96,
  labels: ["comms", "teams", "microsoft", "messaging"],
  metadata: {
    title: "graph.node.comms.teams.name",
    description: "graph.node.comms.teams.description",
  },
})
@model()
export class TeamsNode extends GraphNode<TeamsNodeInput, TeamsNodeOutput> {
  /**
   * Executes the configured Teams operation.
   *
   * @param request - Execution request carrying the credential secrets; the `teams` credential supplies the Graph `token` and/or `webhookUrl`.
    * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result`.
   * @throws {GraphExecutionError} with codes `GRAPH_TEAMS_OPERATION_REQUIRED` (no operation configured), `GRAPH_TEAMS_TEXT_REQUIRED`/`GRAPH_TEAMS_CHANNEL_MESSAGE_REQUIRED`/`GRAPH_TEAMS_TEAM_REQUIRED` (missing per-operation inputs), or `GRAPH_TEAMS_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<TeamsNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Microsoft Teams node requires an operation",
        "GRAPH_TEAMS_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "sendWebhook";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "teams",
      false,
      "Microsoft Teams"
    );
    const service = new TeamsNodeService();
    try {
      await service.boot({
        token: credentialValue(secret, "token", "Microsoft Teams"),
        webhookUrl: credentialValue(
          secret,
          "webhookUrl",
          "Microsoft Teams"
        ),
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "sendWebhook": {
          const text = this.text ?? String(request.inputs["value"] ?? "");
          if (!text) {
            throw new GraphExecutionError(
              "Microsoft Teams sendWebhook requires text",
              "GRAPH_TEAMS_TEXT_REQUIRED"
            );
          }
          return {
            result: await service.sendWebhook({
              text,
              title: this.title,
              markdown: this.markdown,
            }),
          };
        }
        case "sendChannelMessage": {
          if (!this.teamId || !this.channelId || !this.content) {
            throw new GraphExecutionError(
              "Microsoft Teams sendChannelMessage requires teamId, channelId, and content",
              "GRAPH_TEAMS_CHANNEL_MESSAGE_REQUIRED"
            );
          }
          return {
            result: await service.sendChannelMessage({
              teamId: this.teamId,
              channelId: this.channelId,
              content: this.content,
              contentType: this.contentType,
            }),
          };
        }
        case "listTeams":
          return { result: await service.listTeams(asNumber(this.limit)) };
        default: {
          if (!this.teamId) {
            throw new GraphExecutionError(
              "Microsoft Teams listChannels requires a teamId",
              "GRAPH_TEAMS_TEAM_REQUIRED"
            );
          }
          return { result: await service.listChannels(this.teamId) };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Microsoft Teams node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_TEAMS_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Teams operation to perform (default `sendWebhook`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.teams.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: TeamsOperation = "sendWebhook";

  /** Webhook message text (falls back to the `value` input; required by `sendWebhook`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.teams.fields.text.label",
    type: "textarea",
  })
  @input({ handle: "text", userControlled: true })
  text?: string;

  /** Optional message card title for the webhook post. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.teams.fields.title.label",
    type: "string",
  })
  @input({ handle: "title", userControlled: true })
  title?: string;

  /** Render the webhook text as Markdown. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.teams.fields.markdown.label",
    type: "boolean",
  })
  @input({ handle: "markdown", userControlled: true })
  markdown?: boolean;

  /** Graph team id (required by `sendChannelMessage`/`listChannels`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.teams.fields.teamId.label",
    type: "string",
  })
  @input({ handle: "teamId", userControlled: true })
  teamId?: string;

  /** Graph channel id (`sendChannelMessage` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.teams.fields.channelId.label",
    type: "string",
  })
  @input({ handle: "channelId", userControlled: true })
  channelId?: string;

  /** Channel message body (`sendChannelMessage` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.teams.fields.content.label",
    type: "textarea",
  })
  @input({ handle: "content", userControlled: true })
  content?: string;

  /** Channel message body format (default `text`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.teams.fields.contentType.label",
    type: "select",
  })
  @input({ handle: "contentType", userControlled: true })
  contentType?: "text" | "html";

  /** Page size for `listTeams`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.teams.fields.limit.label",
    type: "number",
  })
  @input({ handle: "limit", userControlled: true })
  limit?: number;

  /** Optional Graph API base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.teams.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;
}
