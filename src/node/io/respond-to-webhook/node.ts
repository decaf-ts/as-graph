/**
 * @module as-graph/nodes/io/respond-to-webhook
 * @summary Respond to Webhook IO node declaration (DECAF-746 IO family).
 * @description Respond to Webhook — terminate a webhook-triggered run with an
 * HTTP response. The body is resolved per `respondWith`: `noData` emits
 * `null`, `allIncomingItems`/`firstIncomingItem` take the (normalized) input
 * array, `text` stringifies the configured `responseBody` or the input, and
 * `json` parses a configured string body as JSON (falling back to the raw
 * string), else uses the configured value or the input. String-valued header
 * entries with non-blank keys are kept, and a non-string body auto-supplies
 * `content-type: application/json` when the caller did not set one. The
 * resulting {@link GraphWebhookResponse} is stamped with the run's `runId` and
 * delivered to the engine's `webhookResponses` registry — `runId` is the
 * correlation key the webhook trigger awaits on — and progress is reported;
 * `delivered` reports whether a waiter was actually registered.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import type { GraphWebhookResponse } from "../../../engine/execution/GraphWebhookResponseRegistry";
import { asGraphDataArray } from "../../data/support";

/** What to send as the response body. */
export type RespondWith =
  | "firstIncomingItem"
  | "allIncomingItems"
  | "json"
  | "text"
  | "noData";

/** Inputs accepted by the Respond to Webhook node. */
export type RespondToWebhookNodeInput = Record<string, unknown>;

/** Outputs produced by the Respond to Webhook node. */
export interface RespondToWebhookNodeOutput {
  response: GraphWebhookResponse;
  delivered: boolean;
}

/**
 * Respond to Webhook IO node: resolves and delivers the HTTP response for a
 * webhook-triggered run.
 */
@node("core.io.respondToWebhook", {
  kind: "core.io.respondToWebhook",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-corner-up-left",
  width: 96,
  height: 96,
  labels: ["io", "webhook", "response"],
  metadata: {
    title: "graph.node.io.respond_to_webhook.name",
    description: "graph.node.io.respond_to_webhook.description",
  },
})
@model()
export class RespondToWebhookNode extends GraphNode<
  RespondToWebhookNodeInput,
  RespondToWebhookNodeOutput
> {
  /**
   * Resolves the response body and headers, delivers the response to the
   * engine's webhook registry keyed by `context.runId`, and reports progress.
   *
   * @param request - The execution request carrying the optional `value` input.
   * @param context - The execution context providing the `runId` correlation
   *   key, the engine's `webhookResponses` registry, and the progress channel.
   * @returns The built response and whether a waiter received it (`delivered`
   *   is false when no webhook trigger is awaiting this run).
   */
  override async execute(
    request: GraphNodeExecutionRequest<RespondToWebhookNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const body = this.resolveBody(request);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.responseHeaders ?? {})) {
      if (typeof value === "string" && key.trim().length > 0) {
        headers[key.trim()] = value;
      }
    }
    if (
      body !== null &&
      body !== undefined &&
      typeof body !== "string" &&
      headers["content-type"] === undefined
    ) {
      headers["content-type"] = "application/json";
    }

    const response: GraphWebhookResponse = {
      statusCode: this.responseCode ?? 200,
      headers,
      body,
      runId: context.runId,
      respondedAt: new Date().toISOString(),
    };

    const delivered =
      context.engine?.webhookResponses.deliver(context.runId, response) ?? false;
    await context.progress({ ...response, delivered });
    return { response, delivered };
  }

  /**
   * Builds the response body per `respondWith`, as described in the module
   * description.
   *
   * @param request - The execution request carrying the optional `value` input.
   * @returns The resolved body (`null` for `noData`).
   */
  private resolveBody(
    request: GraphNodeExecutionRequest<RespondToWebhookNodeInput>
  ): unknown {
    const value = request.inputs["value"];
    switch (this.respondWith) {
      case "noData":
        return null;
      case "allIncomingItems":
        return asGraphDataArray(value);
      case "firstIncomingItem":
        return asGraphDataArray(value)[0] ?? null;
      case "text":
        return this.responseBody === undefined
          ? value === undefined || value === null
            ? ""
            : String(value)
          : String(this.responseBody);
      case "json":
      default:
        if (typeof this.responseBody === "string") {
          try {
            return JSON.parse(this.responseBody);
          } catch {
            return this.responseBody;
          }
        }
        return this.responseBody !== undefined ? this.responseBody : value ?? null;
    }
  }

  @input({ handle: "value" })
  value?: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.respond_to_webhook.fields.respondWith.label",
    type: "select",
  })
  @input({ handle: "respondWith", userControlled: true })
  respondWith: RespondWith = "firstIncomingItem";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.respond_to_webhook.fields.responseCode.label",
    type: "number",
  })
  @input({ handle: "responseCode", userControlled: true })
  responseCode?: number = 200;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.respond_to_webhook.fields.responseHeaders.label",
    type: "json",
  })
  @input({ handle: "responseHeaders", userControlled: true, type: "object" })
  responseHeaders?: Record<string, string>;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.respond_to_webhook.fields.responseBody.label",
    type: "json",
  })
  @input({ handle: "responseBody", userControlled: true, type: "object" })
  responseBody?: unknown;

  @required()
  @output({ handle: "response" })
  response!: GraphWebhookResponse;

  @output({ handle: "delivered" })
  delivered?: boolean;
}
