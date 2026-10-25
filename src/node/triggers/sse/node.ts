/**
 * @module as-graph/nodes/triggers/sse
 * @summary Server-Sent Events trigger node declaration (Stage 5b).
 * @description SSE trigger — connects to a Server-Sent Events endpoint and
 * emits the first received event, driving the run. Connections use the
 * `eventsource` client (plan R2 direct-library wrap; the API is the standard
 * SSE client) with the Node fetch runtime. Basic credentials embedded in the
 * URL are moved to an `Authorization` header, matching n8n's behaviour, and an
 * optional `token` credential reference supplies a bearer token through the
 * ctx-bound node credential resolver so no secret ever lands in the graph
 * document. The wait honours `timeoutMs` and the run abort signal, and the
 * connection is closed on every exit path.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { EventSource, type ErrorEvent } from "eventsource";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { asNonEmptyString, resolveNodeCredential } from "../../storage/support";
import { credentialSecret } from "../../credentials";
import {
  triggerFailure,
  triggerPayload,
  triggerTimeoutMs,
  waitForTriggerEvent,
} from "../support";

/** Inputs accepted by the SSE trigger (none — it is an entrypoint). */
export type SseTriggerInput = Record<string, unknown>;

/** Outputs produced by the SSE trigger. */
export interface SseTriggerOutput {
  payload: unknown;
  message?: string;
  event?: string;
  id?: string;
}

/** Splits URL-embedded credentials into a Basic authorization header. */
function splitUrlCredentials(url: URL): {
  url: URL;
  authorization?: string;
} {
  if (!url.username && !url.password) return { url };
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(
    url.password
  )}`;
  const sanitized = new URL(url.toString());
  sanitized.username = "";
  sanitized.password = "";
  return {
    url: sanitized,
    authorization: `Basic ${Buffer.from(credentials, "utf8").toString(
      "base64"
    )}`,
  };
}

/**
 * SSE trigger node: opens an event stream and emits the first event.
 */
@node("core.trigger.sse", {
  kind: "core.trigger.sse",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-rss",
  width: 96,
  height: 96,
  labels: ["trigger", "sse", "events", "stream"],
  metadata: {
    title: "graph.node.trigger.sse.name",
    description: "graph.node.trigger.sse.description",
    trigger: {
      type: "sse",
      url: "",
    },
  },
})
@model()
export class SseTriggerNode extends GraphNode<
  SseTriggerInput,
  SseTriggerOutput
> {
  /**
   * Opens the configured SSE stream and emits its first message.
   *
   * @param request - The execution request carrying resolved credentials.
   * @param context - The node execution context (run abort signal).
   * @returns The event payload, raw data, event name, and event id.
   * @throws {GraphExecutionError} `GRAPH_SSE_TRIGGER_URL_REQUIRED` when no URL is
   *   configured, `GRAPH_TRIGGER_TIMEOUT` when no event arrives in time,
   *   `GRAPH_TRIGGER_ABORTED` when the run is cancelled, and
   *   `GRAPH_SSE_TRIGGER_FAILED` for connection or stream failures.
   */
  override async execute(
    request: GraphNodeExecutionRequest<SseTriggerInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const rawUrl = asNonEmptyString(this.url);
    if (!rawUrl) {
      throw new GraphExecutionError(
        "SSE trigger requires a URL",
        "GRAPH_SSE_TRIGGER_URL_REQUIRED"
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new GraphExecutionError(
        "SSE trigger URL is not a valid URL",
        "GRAPH_SSE_TRIGGER_URL_INVALID"
      );
    }
    const token = credentialSecret(
      await resolveNodeCredential(
        context,
        request.credentials,
        "token",
        false,
        "SSE trigger"
      ),
      ["token", "secret", "apiKey"],
      "SSE trigger"
    );
    const { url, authorization: basic } = splitUrlCredentials(parsed);
    const authorization = token ? `Bearer ${token}` : basic;
    const timeoutMs = triggerTimeoutMs(this.timeoutMs);
    let source: EventSource | undefined;

    try {
      const event = await waitForTriggerEvent<{
        data: string;
        event: string;
        id: string;
      }>(
        context,
        timeoutMs,
        (emit, fail) => {
          source = new EventSource(url, {
            fetch: (input, init) =>
              fetch(input, {
                ...init,
                headers: authorization
                  ? { ...init.headers, Authorization: authorization }
                  : init.headers,
              }),
          });
          source.onopen = () => {
            void context
              .log("SSE trigger connected", { url: url.toString() })
              .catch(() => undefined);
          };
          source.onmessage = (message) =>
            emit({
              data: message.data,
              event: message.type || "message",
              id: message.lastEventId ?? "",
            });
          source.onerror = (error: ErrorEvent) => {
            const status =
              error.code === undefined ? "" : ` (HTTP ${error.code})`;
            fail(
              new GraphExecutionError(
                `SSE trigger connection failed${status}: ${
                  error.message ?? "unknown error"
                }`,
                "GRAPH_SSE_TRIGGER_FAILED"
              )
            );
          };
          return () => source?.close();
        },
        "GRAPH_TRIGGER_TIMEOUT",
        `SSE trigger received no event within ${timeoutMs}ms`
      );
      return {
        payload: triggerPayload(event.data, this.jsonParseBody !== false),
        message: event.data,
        event: event.event,
        id: event.id,
      };
    } catch (error) {
      throw triggerFailure("SSE", "GRAPH_SSE_TRIGGER_FAILED", error);
    } finally {
      source?.close();
    }
  }

  /** SSE endpoint to subscribe to. */
  @required()
  @input({ handle: "url" })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.sse.fields.url.label",
    placeholder: "graph.node.trigger.sse.fields.url.placeholder",
    type: "string",
  })
  url?: string;

  /** Parse the event data as JSON when possible (raw string otherwise). */
  @input({ handle: "jsonParseBody", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.sse.fields.jsonParseBody.label",
    type: "boolean",
  })
  jsonParseBody: boolean = true;

  /** Maximum wait for the first event in milliseconds (default 30000). */
  @input({ handle: "timeoutMs", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.sse.fields.timeoutMs.label",
    type: "number",
  })
  timeoutMs?: number;

  /** The event data, JSON-projected when `jsonParseBody` is enabled. */
  @required()
  @output({ handle: "payload" })
  payload!: unknown;

  /** The raw event data text. */
  @output({ handle: "message" })
  message?: string;

  /** The SSE event name (`message` for unnamed events). */
  @output({ handle: "event" })
  event?: string;

  /** The SSE event id. */
  @output({ handle: "id" })
  id?: string;
}
