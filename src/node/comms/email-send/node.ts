/**
 * @module as-graph/nodes/comms/email-send
 * @summary Email Send Comms node declaration (Stage 3b; `core.comms.emailSend`).
 * @description Email Send — send mail or list an inbox through the Decaf
 * `EmailService`, which multiplexes SMTP, Microsoft Graph, and IMAP. The
 * `email` credential (resolved through a `GRAPH_CREDENTIAL_*` environment
 * variable) is a bare token or a JSON object whose fields (`provider`, `host`,
 * `port`, `secure`, `username`, `password`, `from`, `token`, `graphBaseUrl`)
 * fill any service config the node does not set explicitly — node config
 * always wins. `send` requires `to` and `subject` (text body falls back to the
 * `value` input); `listInbox` and `listImap` read a mailbox with optional
 * `limit`, `since`, and subject filter. An unknown `operation` silently falls
 * back to `send`. A throwaway `EmailService` is initialized per execution and
 * shut down in a `finally` block.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import {
  EmailService,
  type EmailProvider,
} from "@decaf-ts/integrations/comms/email";
import {
  asBoolean,
  asNumber,
  resolveCredentialSecret,
} from "../../storage/support";
import { credentialRecord } from "../../credentials";

/** Operation the node performs (send mail or list an inbox). */
export type EmailSendOperation = "send" | "listInbox" | "listImap";

/** Inputs accepted by the Email Send node. */
export type EmailSendNodeInput = Record<string, unknown>;

/** Outputs produced by the Email Send node. */
export interface EmailSendNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Provider message id of the sent mail (`send` only). */
  messageId?: string;
}

/** Supported operations; unknown configured values fall back to `send`. */
const OPERATIONS: EmailSendOperation[] = ["send", "listInbox", "listImap"];

/**
 * Email Send node (`core.comms.emailSend`): multi-provider mail send and inbox
 * listing through the Decaf `EmailService`.
 *
 * SMTP/Graph credentials and connection settings may live in the `email`
 * credential JSON so secrets never have to be written into node config.
 */
@node("core.comms.emailSend", {
  kind: "core.comms.emailSend",
  category: "Comms",
  color: "#0f766e",
  icon: "ti-mail",
  width: 96,
  height: 96,
  labels: ["comms", "email", "smtp", "imap"],
  metadata: {
    title: "graph.node.comms.email_send.name",
    description: "graph.node.comms.email_send.description",
  },
})
@model()
export class EmailSendNode extends GraphNode<
  EmailSendNodeInput,
  EmailSendNodeOutput
> {
  /**
   * Executes the configured email operation.
   *
   * @param request - Execution request carrying the credential secrets; the `email` credential (bare token or JSON record) is merged under the node config.
   * @returns Execution values with the service response on `result` and, for `send`, the `messageId` output.
   * @throws {GraphExecutionError} with codes `GRAPH_EMAIL_OPERATION_REQUIRED` (no operation configured), `GRAPH_EMAIL_MESSAGE_REQUIRED` (missing `to`/`subject`), or `GRAPH_EMAIL_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<EmailSendNodeInput>
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Email Send node requires an operation",
        "GRAPH_EMAIL_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "send";
    const secret = resolveCredentialSecret(
      request.credentials,
      "email",
      false,
      "Email"
    );
    const credentials = credentialRecord(secret, "Email");
    const rawToken =
      secret && !credentials ? secret : undefined;
    const service = new EmailService();
    try {
      await service.initialize({
        provider:
          this.provider ??
          (credentials?.["provider"] as EmailProvider | undefined),
        host: this.host ?? this.asCredentialString(credentials, "host"),
        port: asNumber(this.port) ?? asNumber(credentials?.["port"]),
        secure:
          this.secure ?? asBoolean(credentials?.["secure"], false),
        username:
          this.username ?? this.asCredentialString(credentials, "username"),
        password: this.asCredentialString(credentials, "password"),
        from: this.from ?? this.asCredentialString(credentials, "from"),
        token:
          rawToken ?? this.asCredentialString(credentials, "token"),
        graphBaseUrl:
          this.graphBaseUrl ??
          this.asCredentialString(credentials, "graphBaseUrl"),
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "send": {
          if (!this.to || !this.subject) {
            throw new GraphExecutionError(
              "Email Send send requires to and subject",
              "GRAPH_EMAIL_MESSAGE_REQUIRED"
            );
          }
          const result = await service.send({
            from:
              this.from ??
              this.asCredentialString(credentials, "from") ??
              "",
            to: this.to,
            cc: this.cc,
            bcc: this.bcc,
            subject: this.subject,
            text: this.text ?? String(request.inputs["value"] ?? ""),
            html: this.html,
            replyTo: this.replyTo,
          });
          return { result, messageId: result.messageId };
        }
        case "listInbox":
          return {
            result: await service.listInbox({
              mailbox: this.mailbox,
              limit: asNumber(this.limit),
              since: this.since,
              subject: this.subjectFilter,
            }),
          };
        default:
          return {
            result: await service.listImapMessages({
              mailbox: this.mailbox,
              limit: asNumber(this.limit),
              since: this.since,
              subject: this.subjectFilter,
            }),
          };
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Email node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_EMAIL_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /**
   * Reads a trimmed non-empty string field from the parsed credential record.
   *
   * @param record - Parsed credential JSON record (or `undefined` when absent).
   * @param field - Credential field name to read.
   * @returns The trimmed string value, or `undefined` when missing/not a string.
   */
  private asCredentialString(
    record: Record<string, unknown> | undefined,
    field: string
  ): string | undefined {
    const value = record?.[field];
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : undefined;
  }

  /** Email operation to perform (default `send`). */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: EmailSendOperation = "send";

  /** Delivery provider (default resolved from the credential or service default). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.provider.label",
    type: "select",
  })
  @input({ handle: "provider", userControlled: true })
  provider?: EmailProvider;

  /** SMTP host (SMTP provider only; falls back to the credential). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.host.label",
    type: "string",
  })
  @input({ handle: "host", userControlled: true })
  host?: string;

  /** SMTP port (falls back to the credential). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.port.label",
    type: "number",
  })
  @input({ handle: "port", userControlled: true })
  port?: number;

  /** Use implicit TLS for SMTP (falls back to the credential). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.secure.label",
    type: "boolean",
  })
  @input({ handle: "secure", userControlled: true })
  secure?: boolean;

  /** SMTP/IMAP username (falls back to the credential). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.username.label",
    type: "string",
  })
  @input({ handle: "username", userControlled: true })
  username?: string;

  /** Sender address (falls back to the credential). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.from.label",
    type: "string",
  })
  @input({ handle: "from", userControlled: true })
  from?: string;

  /** Recipient address(es) (required by `send`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.to.label",
    type: "string",
  })
  @input({ handle: "to", userControlled: true })
  to?: string | string[];

  /** Carbon-copy recipient(s). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.cc.label",
    type: "string",
  })
  @input({ handle: "cc", userControlled: true })
  cc?: string | string[];

  /** Blind carbon-copy recipient(s). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.bcc.label",
    type: "string",
  })
  @input({ handle: "bcc", userControlled: true })
  bcc?: string | string[];

  /** Message subject (required by `send`). */
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

  /** Reply-To header address. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.common.fields.replyTo.label",
    type: "string",
  })
  @input({ handle: "replyTo", userControlled: true })
  replyTo?: string;

  /** Mailbox to read (inbox operations; default service mailbox). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.mailbox.label",
    type: "string",
  })
  @input({ handle: "mailbox", userControlled: true })
  mailbox?: string;

  /** Maximum messages returned by inbox operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.limit.label",
    type: "number",
  })
  @input({ handle: "limit", userControlled: true })
  limit?: number;

  /** Only list messages newer than this date (inbox operations). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.since.label",
    type: "string",
  })
  @input({ handle: "since", userControlled: true })
  since?: string;

  /** Subject substring filter for inbox operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.subjectFilter.label",
    type: "string",
  })
  @input({ handle: "subjectFilter", userControlled: true })
  subjectFilter?: string;

  /** Microsoft Graph base URL override (falls back to the credential). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.graphBaseUrl.label",
    type: "string",
  })
  @input({ handle: "graphBaseUrl", userControlled: true })
  graphBaseUrl?: string;

  /** Optional provider API base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.email_send.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Sent message id (`send` only). */
  @output({ handle: "messageId", type: "string" })
  messageId?: string;
}
