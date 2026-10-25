/**
 * @module as-graph/nodes/io/google-calendar
 * @summary Google Calendar IO node declaration (`core.io.googleCalendar`).
 * @description Google Calendar — calendar listing and event list/get/create/
 * update/delete operations through the Decaf `GoogleCalendarService`. The
 * optional `google-calendar` credential (resolved through the ctx-bound node
 * credential resolver) supplies the OAuth `token` and/or `apiKey` plus the
 * default `calendarId`; the node's `calendarId` wins. The node never embeds
 * credentials. `getEvent`/`updateEvent`/`deleteEvent` require `eventId`;
 * `createEvent` requires `summary`, `start`, and `end`; `listEvents` accepts a
 * time window, result cap, query, and single-events flag. An unknown
 * `operation` silently falls back to `listEvents`. A throwaway
 * `GoogleCalendarService` is initialized per execution and shut down in a
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
import { GoogleCalendarService } from "@decaf-ts/integrations/calendar/google-calendar";
import { bootWithoutEnvironment } from "@decaf-ts/integrations/shared/http";
import { asNumber, asRecord, resolveNodeCredential } from "../../storage/support";
import { credentialValue } from "../../credentials";

/** Operations the node can run against Google Calendar. */
export type GoogleCalendarOperation =
  | "listCalendars"
  | "listEvents"
  | "createEvent"
  | "getEvent"
  | "updateEvent"
  | "deleteEvent";

/** Inputs accepted by the Google Calendar node. */
export type GoogleCalendarNodeInput = Record<string, unknown>;

/** Outputs produced by the Google Calendar node. */
export interface GoogleCalendarNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Created, fetched, updated, or deleted event ID. */
  eventId?: string;
}

/** Supported operations; unknown configured values fall back to `listEvents`. */
const OPERATIONS: GoogleCalendarOperation[] = [
  "listCalendars",
  "listEvents",
  "createEvent",
  "getEvent",
  "updateEvent",
  "deleteEvent",
];

/**
 * Parses the configured `attendees` value into email addresses.
 *
 * Accepts an array, a JSON array string, or a comma/semicolon-separated
 * string. Empty values yield `undefined`; malformed JSON raises
 * `GRAPH_GOOGLE_CALENDAR_ATTENDEES_INVALID`.
 *
 * @param value - Raw `attendees` input from the node configuration.
 * @returns The trimmed attendee addresses, or `undefined` when none are configured.
 * @throws {GraphExecutionError} with code `GRAPH_GOOGLE_CALENDAR_ATTENDEES_INVALID` when a bracketed string is not valid JSON.
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
          "Google Calendar attendees must be a JSON array or a comma-separated list",
          "GRAPH_GOOGLE_CALENDAR_ATTENDEES_INVALID"
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
 * Google Calendar node (`core.io.googleCalendar`): calendar listing and event
 * operations through the Decaf `GoogleCalendarService`.
 */
@node("core.io.googleCalendar", {
  kind: "core.io.googleCalendar",
  category: "IO",
  color: "#4285f4",
  icon: "ti-calendar-event",
  width: 96,
  height: 96,
  labels: ["io", "google", "calendar", "events", "scheduling"],
  metadata: {
    title: "graph.node.io.google_calendar.name",
    description: "graph.node.io.google_calendar.description",
  },
})
@model()
export class GoogleCalendarNode extends GraphNode<
  GoogleCalendarNodeInput,
  GoogleCalendarNodeOutput
> {
  /**
   * Executes the configured Google Calendar operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `google-calendar` credential supplies the token, API key, and default calendar ID.
   * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result`, plus the event ID for event operations.
   * @throws {GraphExecutionError} with codes `GRAPH_GOOGLE_CALENDAR_OPERATION_REQUIRED` (no operation configured), `GRAPH_GOOGLE_CALENDAR_EVENT_REQUIRED` (missing event ID or create fields), `GRAPH_GOOGLE_CALENDAR_ATTENDEES_INVALID` (malformed attendees), or `GRAPH_GOOGLE_CALENDAR_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<GoogleCalendarNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Google Calendar node requires an operation",
        "GRAPH_GOOGLE_CALENDAR_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "listEvents";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "google-calendar",
      false,
      "Google Calendar"
    );
    const service = new GoogleCalendarService();
    try {
      await bootWithoutEnvironment(service, {
        token: credentialValue(secret, "token", "Google Calendar"),
        apiKey: credentialValue(secret, "apiKey", "Google Calendar"),
        calendarId: credentialValue(
          secret,
          "calendarId",
          "Google Calendar"
        ),
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "listCalendars":
          return { result: await service.listCalendars() };
        case "listEvents":
          return {
            result: await service.listEvents({
              calendarId: this.calendarId,
              timeMin: this.timeMin,
              timeMax: this.timeMax,
              maxResults: asNumber(this.maxResults),
              q: this.q,
              singleEvents: this.singleEvents,
            }),
          };
        case "createEvent": {
          if (!this.summary || !this.start || !this.end) {
            throw new GraphExecutionError(
              "Google Calendar createEvent requires summary, start, and end",
              "GRAPH_GOOGLE_CALENDAR_EVENT_REQUIRED"
            );
          }
          const result = await service.createEvent({
            calendarId: this.calendarId,
            summary: this.summary,
            description: this.description,
            location: this.location,
            start: this.start,
            end: this.end,
            timeZone: this.timeZone,
            attendees: parseAttendees(this.attendees),
          });
          const record = asRecord(result);
          return {
            result,
            ...(typeof record?.id === "string" ? { eventId: record.id } : {}),
          };
        }
        case "getEvent": {
          if (!this.eventId) {
            throw new GraphExecutionError(
              "Google Calendar getEvent requires an eventId",
              "GRAPH_GOOGLE_CALENDAR_EVENT_REQUIRED"
            );
          }
          return {
            result: await service.getEvent(
              this.calendarId ?? "primary",
              this.eventId
            ),
            eventId: this.eventId,
          };
        }
        case "updateEvent": {
          if (!this.eventId) {
            throw new GraphExecutionError(
              "Google Calendar updateEvent requires an eventId",
              "GRAPH_GOOGLE_CALENDAR_EVENT_REQUIRED"
            );
          }
          return {
            result: await service.updateEvent(this.eventId, {
              calendarId: this.calendarId,
              summary: this.summary,
              description: this.description,
              location: this.location,
              start: this.start,
              end: this.end,
              timeZone: this.timeZone,
              attendees: parseAttendees(this.attendees),
            }),
            eventId: this.eventId,
          };
        }
        default: {
          if (!this.eventId) {
            throw new GraphExecutionError(
              "Google Calendar deleteEvent requires an eventId",
              "GRAPH_GOOGLE_CALENDAR_EVENT_REQUIRED"
            );
          }
          return {
            result: await service.deleteEvent(
              this.calendarId ?? "primary",
              this.eventId
            ),
            eventId: this.eventId,
          };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Google Calendar node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_GOOGLE_CALENDAR_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Google Calendar operation to perform (default `listEvents`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: GoogleCalendarOperation = "listEvents";

  /** Calendar ID (defaults to the credential value or `primary`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.calendarId.label",
    type: "string",
  })
  @input({ handle: "calendarId", userControlled: true })
  calendarId?: string;

  /** Event ID used by get/update/delete operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.eventId.label",
    type: "string",
  })
  @input({ handle: "eventId", userControlled: true })
  eventId?: string;

  /** Event summary/title. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.summary.label",
    type: "string",
  })
  @input({ handle: "summary", userControlled: true })
  summary?: string;

  /** Event description. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.description.label",
    type: "textarea",
  })
  @input({ handle: "description", userControlled: true })
  description?: string;

  /** Event location. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.location.label",
    type: "string",
  })
  @input({ handle: "location", userControlled: true })
  location?: string;

  /** Event start date (`YYYY-MM-DD`) or date-time (ISO 8601). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.start.label",
    type: "string",
  })
  @input({ handle: "start", userControlled: true })
  start?: string;

  /** Event end date (`YYYY-MM-DD`) or date-time (ISO 8601). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.end.label",
    type: "string",
  })
  @input({ handle: "end", userControlled: true })
  end?: string;

  /** IANA time zone applied to date-time values. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.timeZone.label",
    type: "string",
  })
  @input({ handle: "timeZone", userControlled: true })
  timeZone?: string;

  /** Attendee email addresses, array, or comma-separated/JSON string. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.attendees.label",
    type: "textarea",
  })
  @input({ handle: "attendees", userControlled: true })
  attendees?: unknown;

  /** Lower bound for the event list (ISO 8601). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.timeMin.label",
    type: "string",
  })
  @input({ handle: "timeMin", userControlled: true })
  timeMin?: string;

  /** Upper bound for the event list (ISO 8601). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.timeMax.label",
    type: "string",
  })
  @input({ handle: "timeMax", userControlled: true })
  timeMax?: string;

  /** Maximum number of events returned by `listEvents`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.maxResults.label",
    type: "number",
  })
  @input({ handle: "maxResults", userControlled: true })
  maxResults?: number;

  /** Free-text event search query. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.q.label",
    type: "string",
  })
  @input({ handle: "q", userControlled: true })
  q?: string;

  /** Whether recurring events are expanded into instances. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.singleEvents.label",
    type: "boolean",
  })
  @input({ handle: "singleEvents", userControlled: true })
  singleEvents?: boolean;

  /** Optional Google Calendar API base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_calendar.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Created, fetched, updated, or deleted event ID. */
  @output({ handle: "eventId", type: "string" })
  resultEventId?: string;
}
