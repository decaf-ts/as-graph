/**
 * @module as-graph/nodes/comms/telegram
 * @summary Telegram Comms node declaration (Stage 3b; `core.comms.telegram`).
 * @description Telegram — bot messaging and updates through the Decaf
 * `TelegramService` Bot API. The `telegram` credential (a bare bot token,
 * resolved through the ctx-bound node credential resolver) is optional;
 * unauthorized calls fail with the service's own Telegram API error.
 * `sendMessage` requires a `chatId` and `text` (text falls back to the `value`
 * input) and supports a parse mode, silent send/preview toggles, and
 * reply/thread targeting; `sendChatAction` requires a `chatId` and defaults to
 * the `typing` action. `getMe` and `getUpdates` need no extra inputs. An
 * unknown `operation` silently falls back to `sendMessage`. A throwaway
 * `TelegramService` is initialized per execution and shut down in a `finally`
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
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { TelegramService } from "@decaf-ts/integrations/comms/telegram";
import {
  asNumber,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialToken } from "../../credentials";

/** Operation the node performs against the Telegram Bot API. */
export type TelegramOperation =
  | "sendMessage"
  | "getMe"
  | "getUpdates"
  | "sendChatAction";

/** Text parse mode for sent messages. */
export type TelegramParseMode = "Markdown" | "MarkdownV2" | "HTML";

/** Inputs accepted by the Telegram node. */
export type TelegramNodeInput = Record<string, unknown>;

/** Outputs produced by the Telegram node. */
export interface TelegramNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Id of the sent message (`sendMessage` only). */
  messageId?: number;
}

/** Supported operations; unknown configured values fall back to `sendMessage`. */
const OPERATIONS: TelegramOperation[] = [
  "sendMessage",
  "getMe",
  "getUpdates",
  "sendChatAction",
];

/**
 * Telegram node (`core.comms.telegram`): bot messaging and updates through the
 * Decaf `TelegramService`.
 */
@node("core.comms.telegram", {
  kind: "core.comms.telegram",
  category: "Comms",
  color: "#229ed9",
  icon: "ti-brand-telegram",
  width: 96,
  height: 96,
  labels: ["comms", "telegram", "messaging", "bot"],
  metadata: {
    title: "graph.node.comms.telegram.name",
    description: "graph.node.comms.telegram.description",
  },
})
@model()
export class TelegramNode extends GraphNode<
  TelegramNodeInput,
  TelegramNodeOutput
> {
  /**
   * Executes the configured Telegram operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `telegram` bot token is resolved via `resolveNodeCredential`.
    * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result` and, for `sendMessage`, the `messageId` output.
   * @throws {GraphExecutionError} with codes `GRAPH_TELEGRAM_OPERATION_REQUIRED` (no operation configured), `GRAPH_TELEGRAM_MESSAGE_REQUIRED`/`GRAPH_TELEGRAM_CHAT_REQUIRED` (missing per-operation inputs), or `GRAPH_TELEGRAM_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<TelegramNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Telegram node requires an operation",
        "GRAPH_TELEGRAM_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "sendMessage";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "telegram",
      false,
      "Telegram"
    );
    const token = credentialToken(secret, "Telegram");
    const service = new TelegramService();
    try {
      await service.boot({ token, baseUrl: this.baseUrl });
      switch (operation) {
        case "sendMessage": {
          const chatId = this.chatId;
          const text = this.text ?? String(request.inputs["value"] ?? "");
          if (chatId === undefined || chatId === null || !text) {
            throw new GraphExecutionError(
              "Telegram sendMessage requires a chat ID and text",
              "GRAPH_TELEGRAM_MESSAGE_REQUIRED"
            );
          }
          const result = await service.sendMessage({
            chatId,
            text,
            parseMode: this.parseMode,
            disableNotification: this.disableNotification,
            disablePreview: this.disablePreview,
            replyToMessageId: asNumber(this.replyToMessageId),
            messageThreadId: asNumber(this.messageThreadId),
          });
          return {
            result,
            messageId: asNumber(result?.message_id),
          };
        }
        case "getMe":
          return { result: await service.getMe() };
        case "getUpdates":
          return {
            result: await service.getUpdates({
              offset: asNumber(this.offset),
              limit: asNumber(this.limit),
              timeoutSeconds: asNumber(this.timeoutSeconds),
            }),
          };
        default: {
          if (this.chatId === undefined || this.chatId === null) {
            throw new GraphExecutionError(
              "Telegram sendChatAction requires a chat ID",
              "GRAPH_TELEGRAM_CHAT_REQUIRED"
            );
          }
          return {
            result: await service.sendChatAction(
              this.chatId,
              this.action ?? "typing"
            ),
          };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Telegram node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_TELEGRAM_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Telegram operation to perform (default `sendMessage`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: TelegramOperation = "sendMessage";

  /** Target chat id (required by `sendMessage`/`sendChatAction`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.chatId.label",
    type: "string",
  })
  @input({ handle: "chatId", userControlled: true })
  chatId?: string | number;

  /** Message text (falls back to the `value` input; required by `sendMessage`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.text.label",
    type: "textarea",
  })
  @input({ handle: "text", userControlled: true })
  text?: string;

  /** Parse mode applied to the message text. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.parseMode.label",
    type: "select",
  })
  @input({ handle: "parseMode", userControlled: true })
  parseMode?: TelegramParseMode;

  /** Send the message silently. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.disableNotification.label",
    type: "boolean",
  })
  @input({ handle: "disableNotification", userControlled: true })
  disableNotification?: boolean;

  /** Suppress link previews on the message. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.disablePreview.label",
    type: "boolean",
  })
  @input({ handle: "disablePreview", userControlled: true })
  disablePreview?: boolean;

  /** Message id to reply to. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.replyToMessageId.label",
    type: "number",
  })
  @input({ handle: "replyToMessageId", userControlled: true })
  replyToMessageId?: number;

  /** Forum thread id to post into. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.messageThreadId.label",
    type: "number",
  })
  @input({ handle: "messageThreadId", userControlled: true })
  messageThreadId?: number;

  /** Update offset for `getUpdates`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.offset.label",
    type: "number",
  })
  @input({ handle: "offset", userControlled: true })
  offset?: number;

  /** Update page size for `getUpdates`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.limit.label",
    type: "number",
  })
  @input({ handle: "limit", userControlled: true })
  limit?: number;

  /** Long-polling timeout for `getUpdates`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.timeoutSeconds.label",
    type: "number",
  })
  @input({ handle: "timeoutSeconds", userControlled: true })
  timeoutSeconds?: number;

  /** Chat action to show (default `typing`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.action.label",
    type: "string",
  })
  @input({ handle: "action", userControlled: true })
  action?: string;

  /** Optional API base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.telegram.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Sent message id (`sendMessage` only). */
  @output({ handle: "messageId", type: "number" })
  messageId?: number;
}
