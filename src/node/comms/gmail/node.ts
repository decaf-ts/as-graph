/**
 * @module as-graph/nodes/comms/gmail
 * @summary Gmail Comms node declaration (Stage 3b; `core.comms.gmail`).
 * @description Gmail — message send/list/get and label listing through the
 * Decaf `GmailService` REST API. The `gmail` credential (resolved through a
 * ctx-bound node credential resolver) is a bare OAuth token or a JSON
 * object; a `userId` field in the credential supplies the mailbox when the
 * node's `userId` is unset. `send` requires `from` (falling back to a
 * credential `from` field), `to`, and `subject`, with the text body falling
 * back to the `value` input; `get` requires a `messageId`; `list` and
 * `labels` need no extra inputs. An unknown `operation` silently falls back to
 * `send`. A throwaway `GmailService` is initialized per execution and shut
 * down in a `finally` block.
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
import { GmailService } from "@decaf-ts/integrations/comms/gmail";
import {
  asNumber,
  asStringArray,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialToken, credentialValue } from "../../credentials";

/** Operation the node performs against the Gmail API. */
export type GmailOperation = "send" | "list" | "get" | "labels";

/** Inputs accepted by the Gmail node. */
export type GmailNodeInput = Record<string, unknown>;

/** Outputs produced by the Gmail node. */
export interface GmailNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Sent message id (`send` only). */
  id?: string;
}

/** Supported operations; unknown configured values fall back to `send`. */
const OPERATIONS: GmailOperation[] = ["send", "list", "get", "labels"];

/**
 * Gmail node (`core.comms.gmail`): message and label operations through the
 * Decaf `GmailService`.
 */
@node("core.comms.gmail", {
  kind: "core.comms.gmail",
  category: "Comms",
  color: "#ea4335",
  icon: "ti-brand-google",
  width: 96,
  height: 96,
  labels: ["comms", "gmail", "email", "google"],
  metadata: {
    title: "graph.node.comms.gmail.name",
    description: "graph.node.comms.gmail.description",
  },
})
@model()
export class GmailNode extends GraphNode<GmailNodeInput, GmailNodeOutput> {
  /**
   * Executes the configured Gmail operation.
   *
   * @param request - Execution request carrying the credential secrets; the `gmail` credential supplies the OAuth token and optional `userId`/`from` fields.
    * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result` and, for `send`, the `id` output.
   * @throws {GraphExecutionError} with codes `GRAPH_GMAIL_OPERATION_REQUIRED` (no operation configured), `GRAPH_GMAIL_MESSAGE_REQUIRED`/`GRAPH_GMAIL_MESSAGE_ID_REQUIRED` (missing per-operation inputs), or `GRAPH_GMAIL_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<GmailNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Gmail node requires an operation",
        "GRAPH_GMAIL_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "send";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "gmail",
      false,
      "Gmail"
    );
    const service = new GmailService();
    try {
      await service.boot({
        token: credentialToken(secret, "Gmail"),
        userId: this.userId ?? credentialValue(secret, "userId", "Gmail"),
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "send": {
          const from =
            this.from ?? credentialValue(secret, "from", "Gmail");
          if (!from || !this.to || !this.subject) {
            throw new GraphExecutionError(
              "Gmail send requires from, to, and subject",
              "GRAPH_GMAIL_MESSAGE_REQUIRED"
            );
          }
          const result = await service.send({
            from,
            to: this.to,
            cc: this.cc,
            bcc: this.bcc,
            subject: this.subject,
            text: this.text ?? String(request.inputs["value"] ?? ""),
            html: this.html,
            replyTo: this.replyTo,
          });
          return { result, id: result.id };
        }
        case "list":
          return {
            result: await service.listMessages({
              query: this.query,
              maxResults: asNumber(this.maxResults),
              pageToken: this.pageToken,
              labelIds: asStringArray(this.labelIds)?.map(String),
            }),
          };
        case "get": {
          if (!this.messageId) {
            throw new GraphExecutionError(
              "Gmail get requires a message ID",
              "GRAPH_GMAIL_MESSAGE_ID_REQUIRED"
            );
          }
          return {
            result: await service.getMessage(
              this.messageId,
              this.format ?? "full"
            ),
          };
        }
        default:
          return { result: await service.listLabels() };
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Gmail node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_GMAIL_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Gmail operation to perform (default `send`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.gmail.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: GmailOperation = "send";

  /** Mailbox to operate on (default `me`, overridable via the credential). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.gmail.fields.userId.label",
    type: "string",
  })
  @input({ handle: "userId", userControlled: true })
  userId?: string;

  /** Sender address (`send` only; falls back to the credential `from` field). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.from.label",
    type: "string",
  })
  @input({ handle: "from", userControlled: true })
  from?: string;

  /** Recipient address(es) (`send` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.to.label",
    type: "string",
  })
  @input({ handle: "to", userControlled: true })
  to?: string | string[];

  /** Carbon-copy recipient(s) (`send` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.cc.label",
    type: "string",
  })
  @input({ handle: "cc", userControlled: true })
  cc?: string | string[];

  /** Blind carbon-copy recipient(s) (`send` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.bcc.label",
    type: "string",
  })
  @input({ handle: "bcc", userControlled: true })
  bcc?: string | string[];

  /** Message subject (`send` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.subject.label",
    type: "string",
  })
  @input({ handle: "subject", userControlled: true })
  subject?: string;

  /** Plain-text body (falls back to the `value` input). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.text.label",
    type: "textarea",
  })
  @input({ handle: "text", userControlled: true })
  text?: string;

  /** HTML body (takes precedence over the text body). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.html.label",
    type: "textarea",
  })
  @input({ handle: "html", userControlled: true })
  html?: string;

  /** Reply-To header address (`send` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.replyTo.label",
    type: "string",
  })
  @input({ handle: "replyTo", userControlled: true })
  replyTo?: string;

  /** Gmail search query for `list`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.gmail.fields.query.label",
    type: "string",
  })
  @input({ handle: "query", userControlled: true })
  query?: string;

  /** Page size for `list`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.gmail.fields.maxResults.label",
    type: "number",
  })
  @input({ handle: "maxResults", userControlled: true })
  maxResults?: number;

  /** Pagination token for `list`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.gmail.fields.pageToken.label",
    type: "string",
  })
  @input({ handle: "pageToken", userControlled: true })
  pageToken?: string;

  /** Label filter for `list`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.gmail.fields.labelIds.label",
    type: "json",
  })
  @input({ handle: "labelIds", userControlled: true })
  labelIds?: string[];

  /** Message id to fetch (`get` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.gmail.fields.messageId.label",
    type: "string",
  })
  @input({ handle: "messageId", userControlled: true })
  messageId?: string;

  /** Message fetch format (default `full`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.gmail.fields.format.label",
    type: "select",
  })
  @input({ handle: "format", userControlled: true })
  format?: "full" | "metadata" | "minimal" | "raw";

  /** Optional API base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.gmail.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Sent message id (`send` only). */
  @output({ handle: "id", type: "string" })
  id?: string;
}
