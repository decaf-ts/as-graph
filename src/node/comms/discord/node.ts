/**
 * @module as-graph/nodes/comms/discord
 * @summary Discord Comms node declaration (`core.comms.discord`).
 * @description Discord — message, channel, and reaction operations through the
 * Decaf `DiscordService` Bot API. The optional `discord` credential (resolved
 * through the ctx-bound node credential resolver) supplies the bot token; the
 * node never embeds it. `sendMessage` requires a `channelId` and content
 * (`content` falls back to the `value` input) and supports TTS and JSON
 * `embeds`; `getMessage`/`addReaction` require `channelId` and `messageId`
 * (plus `emoji` for reactions); `listMessages`/`getChannel`/`deleteChannel`
 * require `channelId`; `listChannels` requires `guildId`; `createChannel`
 * requires `guildId` and `name`. An unknown `operation` silently falls back to
 * `sendMessage`. A throwaway `DiscordService` is initialized per execution and
 * shut down in a `finally` block.
 *
 * This is the callable comms node (`core.comms.discord`), distinct from the
 * mastra agent channel kinds `core.agent.trigger.discord` and
 * `core.agent.response.discord`, which receive inbound conversations and post
 * agent replies through host-supplied channel adapters.
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
import { DiscordService } from "@decaf-ts/integrations/comms/discord";
import { bootWithoutEnvironment } from "@decaf-ts/integrations/shared/http";
import {
  asNumber,
  asRecord,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialToken } from "../../credentials";

/** Operations the node can run against the Discord Bot API. */
export type DiscordOperation =
  | "sendMessage"
  | "getMessage"
  | "listMessages"
  | "getChannel"
  | "listChannels"
  | "createChannel"
  | "deleteChannel"
  | "addReaction";

/** Inputs accepted by the Discord node. */
export type DiscordNodeInput = Record<string, unknown>;

/** Outputs produced by the Discord node. */
export interface DiscordNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Channel the operation targeted or the created channel ID. */
  channelId?: string;
  /** Message ID fetched, reacted to, or created by `sendMessage`. */
  messageId?: string;
}

/** Supported operations; unknown configured values fall back to `sendMessage`. */
const OPERATIONS: DiscordOperation[] = [
  "sendMessage",
  "getMessage",
  "listMessages",
  "getChannel",
  "listChannels",
  "createChannel",
  "deleteChannel",
  "addReaction",
];

/**
 * Parses the configured `embeds` value into Discord embed objects.
 *
 * Accepts an array, a JSON array/object string, or a single object; empty
 * values yield `undefined` and malformed JSON raises
 * `GRAPH_DISCORD_EMBEDS_INVALID`.
 *
 * @param value - Raw `embeds` input from the node configuration.
 * @returns The embed objects, or `undefined` when none are configured.
 * @throws {GraphExecutionError} with code `GRAPH_DISCORD_EMBEDS_INVALID` when a string is not valid JSON.
 */
function parseEmbeds(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new GraphExecutionError(
        "Discord embeds must be a JSON array",
        "GRAPH_DISCORD_EMBEDS_INVALID"
      );
    }
  }
  const record = asRecord(value);
  return record ? [record] : undefined;
}

/**
 * Discord node (`core.comms.discord`): messaging, channel administration, and
 * reactions through the Decaf `DiscordService`.
 */
@node("core.comms.discord", {
  kind: "core.comms.discord",
  category: "Comms",
  color: "#5865f2",
  icon: "ti-brand-discord",
  width: 96,
  height: 96,
  labels: ["comms", "discord", "messaging", "chat"],
  metadata: {
    title: "graph.node.comms.discord.name",
    description: "graph.node.comms.discord.description",
  },
})
@model()
export class DiscordNode extends GraphNode<DiscordNodeInput, DiscordNodeOutput> {
  /**
   * Executes the configured Discord operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `discord` bot token is resolved via `resolveNodeCredential`.
   * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result`, the targeted/created `channelId`, and the created/fetched/reaction `messageId` where available.
   * @throws {GraphExecutionError} with codes `GRAPH_DISCORD_OPERATION_REQUIRED` (no operation configured), `GRAPH_DISCORD_CHANNEL_REQUIRED`/`GRAPH_DISCORD_MESSAGE_REQUIRED`/`GRAPH_DISCORD_CONTENT_REQUIRED`/`GRAPH_DISCORD_GUILD_REQUIRED`/`GRAPH_DISCORD_CHANNEL_CREATE_REQUIRED`/`GRAPH_DISCORD_REACTION_REQUIRED` (missing per-operation inputs), `GRAPH_DISCORD_EMBEDS_INVALID` (malformed embeds), or `GRAPH_DISCORD_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<DiscordNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Discord node requires an operation",
        "GRAPH_DISCORD_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "sendMessage";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "discord",
      false,
      "Discord"
    );
    const service = new DiscordService();
    try {
      await bootWithoutEnvironment(service, {
        token: credentialToken(secret, "Discord"),
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "sendMessage": {
          if (!this.channelId) {
            throw new GraphExecutionError(
              "Discord sendMessage requires a channelId",
              "GRAPH_DISCORD_CHANNEL_REQUIRED"
            );
          }
          const content =
            this.content ?? String(request.inputs["value"] ?? "");
          if (!content) {
            throw new GraphExecutionError(
              "Discord sendMessage requires content",
              "GRAPH_DISCORD_CONTENT_REQUIRED"
            );
          }
          const result = await service.sendMessage({
            channelId: this.channelId,
            content,
            tts: this.tts,
            embeds: parseEmbeds(this.embeds),
          });
          const record = asRecord(result);
          return {
            result,
            channelId: this.channelId,
            ...(typeof record?.id === "string"
              ? { messageId: record.id }
              : {}),
          };
        }
        case "getMessage": {
          if (!this.channelId || !this.messageId) {
            throw new GraphExecutionError(
              "Discord getMessage requires channelId and messageId",
              "GRAPH_DISCORD_MESSAGE_REQUIRED"
            );
          }
          return {
            result: await service.getMessage(this.channelId, this.messageId),
            channelId: this.channelId,
            messageId: this.messageId,
          };
        }
        case "listMessages": {
          if (!this.channelId) {
            throw new GraphExecutionError(
              "Discord listMessages requires a channelId",
              "GRAPH_DISCORD_CHANNEL_REQUIRED"
            );
          }
          return {
            result: await service.listMessages({
              channelId: this.channelId,
              limit: asNumber(this.limit),
              before: this.before,
            }),
            channelId: this.channelId,
          };
        }
        case "getChannel": {
          if (!this.channelId) {
            throw new GraphExecutionError(
              "Discord getChannel requires a channelId",
              "GRAPH_DISCORD_CHANNEL_REQUIRED"
            );
          }
          return {
            result: await service.getChannel(this.channelId),
            channelId: this.channelId,
          };
        }
        case "listChannels": {
          if (!this.guildId) {
            throw new GraphExecutionError(
              "Discord listChannels requires a guildId",
              "GRAPH_DISCORD_GUILD_REQUIRED"
            );
          }
          return { result: await service.listChannels(this.guildId) };
        }
        case "createChannel": {
          if (!this.guildId || !this.name) {
            throw new GraphExecutionError(
              "Discord createChannel requires guildId and name",
              "GRAPH_DISCORD_CHANNEL_CREATE_REQUIRED"
            );
          }
          const result = await service.createChannel({
            guildId: this.guildId,
            name: this.name,
            type: asNumber(this.channelType),
            topic: this.topic,
            parentId: this.parentId,
          });
          const record = asRecord(result);
          return {
            result,
            ...(typeof record?.id === "string"
              ? { channelId: record.id }
              : {}),
          };
        }
        case "deleteChannel": {
          if (!this.channelId) {
            throw new GraphExecutionError(
              "Discord deleteChannel requires a channelId",
              "GRAPH_DISCORD_CHANNEL_REQUIRED"
            );
          }
          return {
            result: await service.deleteChannel(this.channelId),
            channelId: this.channelId,
          };
        }
        default: {
          if (!this.channelId || !this.messageId || !this.emoji) {
            throw new GraphExecutionError(
              "Discord addReaction requires channelId, messageId, and emoji",
              "GRAPH_DISCORD_REACTION_REQUIRED"
            );
          }
          return {
            result: await service.addReaction({
              channelId: this.channelId,
              messageId: this.messageId,
              emoji: this.emoji,
            }),
            channelId: this.channelId,
            messageId: this.messageId,
          };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Discord node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_DISCORD_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Discord operation to perform (default `sendMessage`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: DiscordOperation = "sendMessage";

  /** Channel ID used by message, channel, and reaction operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.channelId.label",
    type: "string",
  })
  @input({ handle: "channelId", userControlled: true })
  channelId?: string;

  /** Guild ID used by channel list/create operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.guildId.label",
    type: "string",
  })
  @input({ handle: "guildId", userControlled: true })
  guildId?: string;

  /** Message ID used by get/fetch and reaction operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.messageId.label",
    type: "string",
  })
  @input({ handle: "messageId", userControlled: true })
  messageId?: string;

  /** Message text (falls back to the `value` input). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.content.label",
    type: "textarea",
  })
  @input({ handle: "content", userControlled: true })
  content?: string;

  /** Embed objects, array, or JSON string sent with the message. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.embeds.label",
    type: "textarea",
  })
  @input({ handle: "embeds", userControlled: true })
  embeds?: unknown;

  /** Whether Discord reads the message with text-to-speech. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.tts.label",
    type: "boolean",
  })
  @input({ handle: "tts", userControlled: true })
  tts?: boolean;

  /** Name of the channel created by `createChannel`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.name.label",
    type: "string",
  })
  @input({ handle: "name", userControlled: true })
  name?: string;

  /** Numeric Discord channel type (default text channel). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.channelType.label",
    type: "number",
  })
  @input({ handle: "channelType", userControlled: true })
  channelType?: number;

  /** Optional topic for a created channel. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.topic.label",
    type: "string",
  })
  @input({ handle: "topic", userControlled: true })
  topic?: string;

  /** Optional parent category ID for a created channel. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.parentId.label",
    type: "string",
  })
  @input({ handle: "parentId", userControlled: true })
  parentId?: string;

  /** Emoji added by `addReaction`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.emoji.label",
    type: "string",
  })
  @input({ handle: "emoji", userControlled: true })
  emoji?: string;

  /** Maximum number of messages returned by `listMessages`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.limit.label",
    type: "number",
  })
  @input({ handle: "limit", userControlled: true })
  limit?: number;

  /** Message ID cursor for paging older messages. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.before.label",
    type: "string",
  })
  @input({ handle: "before", userControlled: true })
  before?: string;

  /** Optional Discord API base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.discord.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Targeted or created channel ID. */
  @output({ handle: "channelId", type: "string" })
  resultChannelId?: string;

  /** Created, fetched, or reacted-to message ID. */
  @output({ handle: "messageId", type: "string" })
  resultMessageId?: string;
}
