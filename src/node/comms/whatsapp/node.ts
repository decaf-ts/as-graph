/**
 * @module as-graph/nodes/comms/whatsapp
 * @summary WhatsApp Comms node declaration (`core.comms.whatsApp`).
 * @description WhatsApp — text, template, and media messages, read receipts,
 * and media lookup through the Decaf `WhatsAppService` Cloud API. The optional
 * `whatsapp` credential (resolved through the ctx-bound node credential
 * resolver) supplies the access token and may also supply the sender
 * `phoneNumberId`; the node's `phoneNumberId` wins. The node never embeds
 * credentials. `sendText` requires `to` and text (`text` falls back to the
 * `value` input); `sendTemplate` requires `to`, `templateName`, and
 * `languageCode`; `sendMedia` requires `to` and a `mediaId` or `mediaUrl`;
 * `markAsRead` requires `messageId`; `getMedia` requires `mediaId`. An unknown
 * `operation` silently falls back to `sendText`. A throwaway
 * `WhatsAppService` is initialized per execution and shut down in a `finally`
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
import {
  WhatsAppService,
  type WhatsAppMediaType,
} from "@decaf-ts/integrations/comms/whatsapp";
import { bootWithoutEnvironment } from "@decaf-ts/integrations/shared/http";
import { asRecord, resolveNodeCredential } from "../../storage/support";
import { credentialToken, credentialValue } from "../../credentials";

/** Operations the node can run against the WhatsApp Cloud API. */
export type WhatsAppOperation =
  | "sendText"
  | "sendTemplate"
  | "sendMedia"
  | "markAsRead"
  | "getMedia";

/** Inputs accepted by the WhatsApp node. */
export type WhatsAppNodeInput = Record<string, unknown>;

/** Outputs produced by the WhatsApp node. */
export interface WhatsAppNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** ID of the message sent or marked as read. */
  messageId?: string;
}

/** Supported operations; unknown configured values fall back to `sendText`. */
const OPERATIONS: WhatsAppOperation[] = [
  "sendText",
  "sendTemplate",
  "sendMedia",
  "markAsRead",
  "getMedia",
];

/**
 * Parses the configured template `components` into WhatsApp template components.
 *
 * Accepts an array, a JSON array/object string, or a single object; empty
 * values yield `undefined` and malformed JSON raises
 * `GRAPH_WHATSAPP_COMPONENTS_INVALID`.
 *
 * @param value - Raw `components` input from the node configuration.
 * @returns The template components, or `undefined` when none are configured.
 * @throws {GraphExecutionError} with code `GRAPH_WHATSAPP_COMPONENTS_INVALID` when a string is not valid JSON.
 */
function parseComponents(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new GraphExecutionError(
        "WhatsApp template components must be a JSON array",
        "GRAPH_WHATSAPP_COMPONENTS_INVALID"
      );
    }
  }
  const record = asRecord(value);
  return record ? [record] : undefined;
}

/**
 * WhatsApp node (`core.comms.whatsApp`): messaging, read receipts, and media
 * lookup through the Decaf `WhatsAppService`.
 */
@node("core.comms.whatsApp", {
  kind: "core.comms.whatsApp",
  category: "Comms",
  color: "#25d366",
  icon: "ti-brand-whatsapp",
  width: 96,
  height: 96,
  labels: ["comms", "whatsapp", "messaging", "meta"],
  metadata: {
    title: "graph.node.comms.whatsapp.name",
    description: "graph.node.comms.whatsapp.description",
  },
})
@model()
export class WhatsAppNode extends GraphNode<
  WhatsAppNodeInput,
  WhatsAppNodeOutput
> {
  /**
   * Executes the configured WhatsApp operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `whatsapp` credential supplies the access token and may supply `phoneNumberId`.
   * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result` and the message ID on `messageId` for sends and read receipts.
   * @throws {GraphExecutionError} with codes `GRAPH_WHATSAPP_OPERATION_REQUIRED` (no operation configured), `GRAPH_WHATSAPP_TEXT_REQUIRED`/`GRAPH_WHATSAPP_TEMPLATE_REQUIRED`/`GRAPH_WHATSAPP_MEDIA_REQUIRED`/`GRAPH_WHATSAPP_MESSAGE_REQUIRED` (missing per-operation inputs), `GRAPH_WHATSAPP_COMPONENTS_INVALID` (malformed components), or `GRAPH_WHATSAPP_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<WhatsAppNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "WhatsApp node requires an operation",
        "GRAPH_WHATSAPP_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "sendText";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "whatsapp",
      false,
      "WhatsApp"
    );
    const service = new WhatsAppService();
    try {
      await bootWithoutEnvironment(service, {
        token: credentialToken(secret, "WhatsApp"),
        phoneNumberId:
          this.phoneNumberId ??
          credentialValue(secret, "phoneNumberId", "WhatsApp"),
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "sendText": {
          const text = this.text ?? String(request.inputs["value"] ?? "");
          if (!this.to || !text) {
            throw new GraphExecutionError(
              "WhatsApp sendText requires to and text",
              "GRAPH_WHATSAPP_TEXT_REQUIRED"
            );
          }
          const result = await service.sendText({
            to: this.to,
            text,
            previewUrl: this.previewUrl,
          });
          return { result, ...this.messageIdOf(result) };
        }
        case "sendTemplate": {
          if (!this.to || !this.templateName || !this.languageCode) {
            throw new GraphExecutionError(
              "WhatsApp sendTemplate requires to, templateName, and languageCode",
              "GRAPH_WHATSAPP_TEMPLATE_REQUIRED"
            );
          }
          const result = await service.sendTemplate({
            to: this.to,
            templateName: this.templateName,
            languageCode: this.languageCode,
            components: parseComponents(this.components),
          });
          return { result, ...this.messageIdOf(result) };
        }
        case "sendMedia": {
          if (!this.to || (!this.mediaId && !this.mediaUrl)) {
            throw new GraphExecutionError(
              "WhatsApp sendMedia requires to and a mediaId or mediaUrl",
              "GRAPH_WHATSAPP_MEDIA_REQUIRED"
            );
          }
          const result = await service.sendMedia({
            to: this.to,
            type: (this.mediaType ?? "image") as WhatsAppMediaType,
            mediaId: this.mediaId,
            link: this.mediaUrl,
            caption: this.caption,
            filename: this.filename,
          });
          return { result, ...this.messageIdOf(result) };
        }
        case "markAsRead": {
          if (!this.messageId) {
            throw new GraphExecutionError(
              "WhatsApp markAsRead requires a messageId",
              "GRAPH_WHATSAPP_MESSAGE_REQUIRED"
            );
          }
          return {
            result: await service.markAsRead({ messageId: this.messageId }),
            messageId: this.messageId,
          };
        }
        default: {
          if (!this.mediaId) {
            throw new GraphExecutionError(
              "WhatsApp getMedia requires a mediaId",
              "GRAPH_WHATSAPP_MEDIA_REQUIRED"
            );
          }
          return { result: await service.getMedia(this.mediaId) };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `WhatsApp node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_WHATSAPP_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /**
   * Extracts the first message ID from a WhatsApp send response.
   *
   * @param result - Raw service response from a send operation.
   * @returns The first message ID when present, otherwise an empty object.
   */
  private messageIdOf(result: unknown): { messageId?: string } {
    const record = asRecord(result);
    const messages = record?.messages;
    if (Array.isArray(messages)) {
      const first = asRecord(messages[0]);
      if (typeof first?.id === "string") return { messageId: first.id };
    }
    return {};
  }

  /** WhatsApp operation to perform (default `sendText`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: WhatsAppOperation = "sendText";

  /** Sender phone number ID (overrides the credential's default). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.phoneNumberId.label",
    type: "string",
  })
  @input({ handle: "phoneNumberId", userControlled: true })
  phoneNumberId?: string;

  /** Recipient phone number in international format. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.to.label",
    type: "string",
  })
  @input({ handle: "to", userControlled: true })
  to?: string;

  /** Text message body (falls back to the `value` input). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.text.label",
    type: "textarea",
  })
  @input({ handle: "text", userControlled: true })
  text?: string;

  /** Whether WhatsApp generates a link preview. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.previewUrl.label",
    type: "boolean",
  })
  @input({ handle: "previewUrl", userControlled: true })
  previewUrl?: boolean;

  /** Approved template name used by `sendTemplate`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.templateName.label",
    type: "string",
  })
  @input({ handle: "templateName", userControlled: true })
  templateName?: string;

  /** Template language code (e.g. `en_US`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.languageCode.label",
    type: "string",
  })
  @input({ handle: "languageCode", userControlled: true })
  languageCode?: string;

  /** Template components, array, or JSON string. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.components.label",
    type: "textarea",
  })
  @input({ handle: "components", userControlled: true })
  components?: unknown;

  /** Media kind for `sendMedia` (default `image`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.mediaType.label",
    type: "select",
  })
  @input({ handle: "mediaType", userControlled: true })
  mediaType?: WhatsAppMediaType;

  /** Uploaded WhatsApp media ID. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.mediaId.label",
    type: "string",
  })
  @input({ handle: "mediaId", userControlled: true })
  mediaId?: string;

  /** Public media URL sent as the media link. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.mediaUrl.label",
    type: "string",
  })
  @input({ handle: "mediaUrl", userControlled: true })
  mediaUrl?: string;

  /** Optional media caption. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.caption.label",
    type: "string",
  })
  @input({ handle: "caption", userControlled: true })
  caption?: string;

  /** Optional document filename. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.filename.label",
    type: "string",
  })
  @input({ handle: "filename", userControlled: true })
  filename?: string;

  /** Inbound message ID acknowledged by `markAsRead`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.messageId.label",
    type: "string",
  })
  @input({ handle: "messageId", userControlled: true })
  messageId?: string;

  /** Optional WhatsApp Graph API base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.whatsapp.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Sent or acknowledged message ID. */
  @output({ handle: "messageId", type: "string" })
  resultMessageId?: string;
}
