/**
 * @module as-graph/nodes/triggers/webhook
 * @summary Webhook trigger node declaration (DECAF-32 §22.2.1).
 * @description Webhook trigger — HTTP request received; path/method/auth/
 * responseMode config.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { node, output } from "../../shared/graph";
import { GraphNode } from "../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";

/**
 * Webhook trigger node: HTTP request entrypoint with path/method/auth/responseMode configuration.
 */
@node("core.trigger.webhook", {
  kind: "core.trigger.webhook",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-webhook",
  width: 96,
  height: 96,
  labels: ["trigger", "webhook", "http"],
  metadata: {
    title: "Webhook trigger",
    description:
      "Starts the workflow when an HTTP request is received on the configured path and method.",
    trigger: {
      type: "webhook",
      path: "/webhook",
      method: "POST",
      auth: "none",
      responseMode: "onReceived",
    },
  },
})
@model()
export class WebhookTriggerNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return { payload: request.inputs["payload"] ?? null };
  }

  @required()
  @uielement("textarea", {
    label: "Request payload",
    placeholder: "Webhook request body",
  })
  @output({ handle: "payload" })
  payload!: unknown;
}
