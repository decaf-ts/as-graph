/**
 * @module as-graph/nodes/comms/outlook
 * @summary Microsoft Outlook Comms node declaration (`core.comms.microsoftOutlook`).
 * @description Microsoft Outlook — mail and calendar operations through the
 * Decaf `MicrosoftOutlookService` (Microsoft Graph). The optional
 * `microsoft-outlook` credential (resolved through the ctx-bound node
 * credential resolver) supplies the Graph access token; the node never embeds
 * it. `sendMail` requires `to` and `subject` (the body falls back to the
 * `value` input); `getMessage` requires `messageId`; `createEvent` requires
 * `subject`, `start`, and `end`; `deleteEvent` requires `eventId`;
 * `listMessages` and `listEvents` accept `top`/`filter`/`search`. An unknown
 * `operation` silently falls back to `sendMail`. A throwaway
 * `MicrosoftOutlookService` is initialized per execution and shut down in a
 * `finally` block.
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
import { MicrosoftOutlookService } from "@decaf-ts/integrations/comms/outlook";
import { bootWithoutEnvironment } from "@decaf-ts/integrations/shared/http";
import {
  asNumber,
  asRecord,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialToken } from "../../credentials";

/** Operations the node can run against Microsoft Outlook. */
export type OutlookOperation =
  | "sendMail"
  | "listMessages"
  | "getMessage"
  | "listEvents"
  | "createEvent"
  | "deleteEvent";

/** Inputs accepted by the Microsoft Outlook node. */
export type OutlookNodeInput = Record<string, unknown>;

/** Outputs produced by the Microsoft Outlook node. */
export interface OutlookNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Message ID fetched by `getMessage`. */
  messageId?: string;
  /** Event ID created or deleted by the calendar operations. */
  eventId?: string;
}

/** Supported operations; unknown configured values fall back to `sendMail`. */
const OPERATIONS: OutlookOperation[] = [
  "sendMail",
  "listMessages",
  "getMessage",
  "listEvents",
  "createEvent",
  "deleteEvent",
];

/**
 * Parses the configured `attendees` value into email addresses.
 *
 * Accepts an array, a JSON array string, or a comma/semicolon-separated
 * string. Empty values yield `undefined`; malformed JSON raises
 * `GRAPH_OUTLOOK_ATTENDEES_INVALID`.
 *
 * @param value - Raw `attendees` input from the node configuration.
 * @returns The trimmed attendee addresses, or `undefined` when none are configured.
 * @throws {GraphExecutionError} with code `GRAPH_OUTLOOK_ATTENDEES_INVALID` when a bracketed string is not valid JSON.
 */
function parseAttendees(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    if (value.trim().startsWith("[")) {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
          ? parsed.map((entry) => String(entry).trim())
          : undefined;
      } catch {
        throw new GraphExecutionError(
          "Microsoft Outlook attendees must be a JSON array or a comma-separated list",
          "GRAPH_OUTLOOK_ATTENDEES_INVALID"
        );
      }
    }
    return value
      .split(/[,;]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return undefined;
}

/**
 * Microsoft Outlook node (`core.comms.microsoftOutlook`): mail and calendar
 * operations through the Decaf `MicrosoftOutlookService`.
 */
@node("core.comms.microsoftOutlook", {
  kind: "core.comms.microsoftOutlook",
  category: "Comms",
  color: "#0078d4",
  icon: "ti-brand-office",
  width: 96,
  height: 96,
  labels: ["comms", "outlook", "microsoft", "email", "calendar"],
  metadata: {
    title: "graph.node.comms.microsoft_outlook.name",
    description: "graph.node.comms.microsoft_outlook.description",
  },
})
@model()
export class MicrosoftOutlookNode extends GraphNode<
  OutlookNodeInput,
  OutlookNodeOutput
> {
  /**
   * Executes the configured Microsoft Outlook operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `microsoft-outlook` Graph access token is resolved via `resolveNodeCredential`.
   * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result`, plus `messageId` for `getMessage` and `eventId` for created/deleted events.
   * @throws {GraphExecutionError} with codes `GRAPH_OUTLOOK_OPERATION_REQUIRED` (no operation configured), `GRAPH_OUTLOOK_MAIL_REQUIRED`/`GRAPH_OUTLOOK_MESSAGE_REQUIRED`/`GRAPH_OUTLOOK_EVENT_REQUIRED` (missing per-operation inputs), `GRAPH_OUTLOOK_ATTENDEES_INVALID` (malformed attendees), or `GRAPH_OUTLOOK_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<OutlookNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Microsoft Outlook node requires an operation",
        "GRAPH_OUTLOOK_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "sendMail";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "microsoft-outlook",
      false,
      "Microsoft Outlook"
    );
    const service = new MicrosoftOutlookService();
    try {
      await bootWithoutEnvironment(service, {
        token: credentialToken(secret, "Microsoft Outlook"),
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "sendMail": {
          if (!this.to || !this.subject) {
            throw new GraphExecutionError(
              "Microsoft Outlook sendMail requires to and subject",
              "GRAPH_OUTLOOK_MAIL_REQUIRED"
            );
          }
          const content =
            this.body ?? String(request.inputs["value"] ?? "");
          return {
            result: await service.sendMail({
              to: this.to,
              cc: this.cc,
              bcc: this.bcc,
              subject: this.subject,
              body: content,
              contentType: this.contentType,
              saveToSentItems: this.saveToSentItems,
            }),
          };
        }
        case "listMessages":
          return {
            result: await service.listMessages({
              folderId: this.folderId,
              top: asNumber(this.top),
              filter: this.filter,
              search: this.search,
            }),
          };
        case "getMessage": {
          if (!this.messageId) {
            throw new GraphExecutionError(
              "Microsoft Outlook getMessage requires a messageId",
              "GRAPH_OUTLOOK_MESSAGE_REQUIRED"
            );
          }
          return {
            result: await service.getMessage(this.messageId),
            messageId: this.messageId,
          };
        }
        case "listEvents":
          return {
            result: await service.listEvents({
              top: asNumber(this.top),
              filter: this.filter,
              search: this.search,
            }),
          };
        case "createEvent": {
          if (!this.subject || !this.start || !this.end) {
            throw new GraphExecutionError(
              "Microsoft Outlook createEvent requires subject, start, and end",
              "GRAPH_OUTLOOK_EVENT_REQUIRED"
            );
          }
          const result = await service.createEvent({
            subject: this.subject,
            start: this.start,
            end: this.end,
            timeZone: this.timeZone,
            body: this.body,
            location: this.location,
            attendees: parseAttendees(this.attendees),
          });
          const record = asRecord(result);
          return {
            result,
            ...(typeof record?.id === "string" ? { eventId: record.id } : {}),
          };
        }
        default: {
          if (!this.eventId) {
            throw new GraphExecutionError(
              "Microsoft Outlook deleteEvent requires an eventId",
              "GRAPH_OUTLOOK_EVENT_REQUIRED"
            );
          }
          return {
            result: await service.deleteEvent(this.eventId),
            eventId: this.eventId,
          };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Microsoft Outlook node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_OUTLOOK_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Outlook operation to perform (default `sendMail`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: OutlookOperation = "sendMail";

  /** Primary recipient address(es). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.to.label",
    type: "string",
  })
  @input({ handle: "to", userControlled: true })
  to?: string;

  /** Carbon-copy recipient address(es). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.cc.label",
    type: "string",
  })
  @input({ handle: "cc", userControlled: true })
  cc?: string;

  /** Blind-carbon-copy recipient address(es). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.bcc.label",
    type: "string",
  })
  @input({ handle: "bcc", userControlled: true })
  bcc?: string;

  /** Mail subject or event subject. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.subject.label",
    type: "string",
  })
  @input({ handle: "subject", userControlled: true })
  subject?: string;

  /** Mail/event body text (mail falls back to the `value` input). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.body.label",
    type: "textarea",
  })
  @input({ handle: "body", userControlled: true })
  body?: string;

  /** Mail body content type (default `Text`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.contentType.label",
    type: "select",
  })
  @input({ handle: "contentType", userControlled: true })
  contentType?: "Text" | "HTML";

  /** Whether sent mail is saved to Sent Items. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.saveToSentItems.label",
    type: "boolean",
  })
  @input({ handle: "saveToSentItems", userControlled: true })
  saveToSentItems?: boolean;

  /** Mail folder ID used by `listMessages` (default `inbox`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.folderId.label",
    type: "string",
  })
  @input({ handle: "folderId", userControlled: true })
  folderId?: string;

  /** Message ID fetched by `getMessage`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.messageId.label",
    type: "string",
  })
  @input({ handle: "messageId", userControlled: true })
  messageId?: string;

  /** Event ID deleted by `deleteEvent`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.eventId.label",
    type: "string",
  })
  @input({ handle: "eventId", userControlled: true })
  eventId?: string;

  /** Event start date-time (ISO 8601). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.start.label",
    type: "string",
  })
  @input({ handle: "start", userControlled: true })
  start?: string;

  /** Event end date-time (ISO 8601). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.end.label",
    type: "string",
  })
  @input({ handle: "end", userControlled: true })
  end?: string;

  /** IANA time zone for event start/end (default `UTC`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.timeZone.label",
    type: "string",
  })
  @input({ handle: "timeZone", userControlled: true })
  timeZone?: string;

  /** Event location display name. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.location.label",
    type: "string",
  })
  @input({ handle: "location", userControlled: true })
  location?: string;

  /** Event attendees, array, or comma-separated/JSON string. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.attendees.label",
    type: "textarea",
  })
  @input({ handle: "attendees", userControlled: true })
  attendees?: unknown;

  /** Maximum number of results for list operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.top.label",
    type: "number",
  })
  @input({ handle: "top", userControlled: true })
  top?: number;

  /** OData filter expression for list operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.filter.label",
    type: "string",
  })
  @input({ handle: "filter", userControlled: true })
  filter?: string;

  /** OData search expression for list operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.search.label",
    type: "string",
  })
  @input({ handle: "search", userControlled: true })
  search?: string;

  /** Optional Microsoft Graph base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.comms.microsoft_outlook.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Fetched message ID. */
  @output({ handle: "messageId", type: "string" })
  resultMessageId?: string;

  /** Created or deleted event ID. */
  @output({ handle: "eventId", type: "string" })
  resultEventId?: string;
}
