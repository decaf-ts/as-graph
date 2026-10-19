/**
 * @module as-graph/nodes/comms/slack
 * @summary Slack Comms node declaration (Stage 3b; `core.comms.slack`).
 * @description Slack — message posting, conversation listing/lookup, and user
 * lookup through the Decaf `SlackService`. The `slack` credential (a bare bot
 * token, resolved through a `GRAPH_CREDENTIAL_*` environment variable) is
 * optional; operations that need authorization fail with the service's own
 * Slack API error. `postMessage` requires a `channel` and `text` (text falls
 * back to the `value` input) and supports Block Kit `blocks`, threading
 * (`threadTs`, `replyBroadcast`), and unfurl toggles; `getConversation`
 * requires a `channel` and `getUser` requires a `userId`. An unknown
 * `operation` silently falls back to `postMessage`. A throwaway
 * `SlackService` is initialized per execution and shut down in a `finally`
 * block.
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
import {
  SlackService,
  type SlackChannel,
} from "@decaf-ts/integrations/comms/slack";
import {
  asNumber,
  asStringArray,
  resolveCredentialSecret,
} from "../../storage/support";
import { credentialToken } from "../../credentials";

/** Operation the node performs against the Slack API. */
export type SlackOperation =
  | "postMessage"
  | "listConversations"
  | "getConversation"
  | "getUser";

/** Inputs accepted by the Slack node. */
export type SlackNodeInput = Record<string, unknown>;

/** Outputs produced by the Slack node. */
export interface SlackNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Channel id the message was posted to or looked up (message/`getConversation` only). */
  channel?: string;
  /** Timestamp of the posted message (`postMessage` only). */
  ts?: string;
}

/** Supported operations; unknown configured values fall back to `postMessage`. */
const OPERATIONS: SlackOperation[] = [
  "postMessage",
  "listConversations",
  "getConversation",
  "getUser",
];

/**
 * Slack node (`core.comms.slack`): messaging and workspace lookups through the
 * Decaf `SlackService`.
 */
@node("core.comms.slack", {
  kind: "core.comms.slack",
  category: "Comms",
  color: "#4a154b",
  icon: "ti-brand-slack",
  width: 96,
  height: 96,
  labels: ["comms", "slack", "messaging", "chat"],
  metadata: {
    title: "graph.node.comms.slack.name",
    description: "graph.node.comms.slack.description",
  },
})
@model()
export class SlackNode extends GraphNode<SlackNodeInput, SlackNodeOutput> {
  /**
   * Executes the configured Slack operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `slack` bot token is resolved via `resolveCredentialSecret`.
   * @returns Execution values with the service response on `result` and, for message writes/`getConversation`, the `channel` (and `ts`) outputs.
   * @throws {GraphExecutionError} with codes `GRAPH_SLACK_OPERATION_REQUIRED` (no operation configured), `GRAPH_SLACK_MESSAGE_REQUIRED`/`GRAPH_SLACK_CHANNEL_REQUIRED`/`GRAPH_SLACK_USER_REQUIRED` (missing per-operation inputs), or `GRAPH_SLACK_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<SlackNodeInput>
  ): Promise<GraphExecutionValues> {
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "postMessage";
    if (!this.operation) {
      throw new GraphExecutionError(
        "Slack node requires an operation",
        "GRAPH_SLACK_OPERATION_REQUIRED"
      );
    }
    const secret = resolveCredentialSecret(
      request.credentials,
      "slack",
      false,
      "Slack"
    );
    const token = credentialToken(secret, "Slack");
    const service = new SlackService();
    try {
      await service.initialize({
        token,
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "postMessage": {
          const channel = this.channel;
          const text = this.text ?? String(request.inputs["value"] ?? "");
          if (!channel || !text) {
            throw new GraphExecutionError(
              "Slack postMessage requires a channel and text",
              "GRAPH_SLACK_MESSAGE_REQUIRED"
            );
          }
          const result = await service.postMessage({
            channel,
            text,
            blocks: asStringArray(this.blocks),
            threadTs: this.threadTs,
            replyBroadcast: this.replyBroadcast,
            unfurlLinks: this.unfurlLinks,
            unfurlMedia: this.unfurlMedia,
          });
          return { result, channel: result.channel, ts: result.ts };
        }
        case "listConversations": {
          const result = await service.listConversations({
            limit: asNumber(this.limit),
            cursor: this.cursor,
            types: this.types,
            excludeArchived: this.excludeArchived,
          });
          return { result };
        }
        case "getConversation": {
          if (!this.channel) {
            throw new GraphExecutionError(
              "Slack getConversation requires a channel",
              "GRAPH_SLACK_CHANNEL_REQUIRED"
            );
          }
          const result: SlackChannel = await service.getConversation(
            this.channel
          );
          return { result, channel: result.id };
        }
        default: {
          if (!this.userId) {
            throw new GraphExecutionError(
              "Slack getUser requires a user ID",
              "GRAPH_SLACK_USER_REQUIRED"
            );
          }
          return { result: await service.getUser(this.userId) };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Slack node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_SLACK_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Slack operation to perform (default `postMessage`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: SlackOperation = "postMessage";

  /** Channel id or name (required by `postMessage`/`getConversation`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.channel.label",
    type: "string",
  })
  @input({ handle: "channel", userControlled: true })
  channel?: string;

  /** Message text (falls back to the `value` input; required by `postMessage`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.text.label",
    type: "textarea",
  })
  @input({ handle: "text", userControlled: true })
  text?: string;

  /** Optional Block Kit layout blocks attached to the message. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.blocks.label",
    type: "json",
  })
  @input({ handle: "blocks", userControlled: true })
  blocks?: unknown[];

  /** Parent message timestamp to reply in-thread. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.threadTs.label",
    type: "string",
  })
  @input({ handle: "threadTs", userControlled: true })
  threadTs?: string;

  /** Page size for `listConversations` and `getUpdates`-style pagination. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.limit.label",
    type: "number",
  })
  @input({ handle: "limit", userControlled: true })
  limit?: number;

  /** Pagination cursor for `listConversations`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.cursor.label",
    type: "string",
  })
  @input({ handle: "cursor", userControlled: true })
  cursor?: string;

  /** Comma-separated conversation types for `listConversations`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.types.label",
    type: "string",
  })
  @input({ handle: "types", userControlled: true })
  types?: string;

  /** Slack user id (`getUser` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.userId.label",
    type: "string",
  })
  @input({ handle: "userId", userControlled: true })
  userId?: string;

  /** Optional API base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Exclude archived conversations from `listConversations`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.excludeArchived.label",
    type: "boolean",
  })
  @input({ handle: "excludeArchived", userControlled: true })
  excludeArchived?: boolean;

  /** Broadcast the in-thread reply to the channel. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.replyBroadcast.label",
    type: "boolean",
  })
  @input({ handle: "replyBroadcast", userControlled: true })
  replyBroadcast?: boolean;

  /** Toggle link unfurling on the posted message. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.unfurlLinks.label",
    type: "boolean",
  })
  @input({ handle: "unfurlLinks", userControlled: true })
  unfurlLinks?: boolean;

  /** Toggle media unfurling on the posted message. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.slack.fields.unfurlMedia.label",
    type: "boolean",
  })
  @input({ handle: "unfurlMedia", userControlled: true })
  unfurlMedia?: boolean;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Channel id (message write and `getConversation` operations only). */
  @output({ handle: "channel", type: "string" })
  resultChannel?: string;

  /** Message timestamp (`postMessage` only). */
  @output({ handle: "ts", type: "string" })
  resultTs?: string;
}
