/**
 * @module as-graph/nodes/triggers/webhook
 * @summary Webhook trigger node declaration (DECAF-32 §22.2.1).
 * @description Webhook trigger — HTTP request received; path/method/auth/
 * responseMode config. The received request body shape is declared by the
 * `schema` property (a `ModelBuilder`-produced model rendered with the
 * for-angular model-builder web component); the `payload` output is a plain
 * canvas port and is deliberately not a `@uielement` (it is data, not config).
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import { assertTriggerPayload, triggerRunPayload } from "../support";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the webhook trigger (none — it is an entrypoint). */
export type WebhookTriggerInput = Record<string, unknown>;

/** Outputs produced by the webhook trigger. */
export interface WebhookTriggerOutput {
  payload: unknown;
}

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
    title: "graph.node.trigger.webhook.name",
    description:
      "graph.node.trigger.webhook.description",
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
export class WebhookTriggerNode extends GraphNode<
  WebhookTriggerInput,
  WebhookTriggerOutput
> {
  /**
   * Returns the received HTTP request payload supplied by the run caller.
   *
   * @param {GraphNodeExecutionRequest<WebhookTriggerInput>} request - Execution request carrying the webhook payload.
   * @return {GraphExecutionValues} The `payload` output value (the whole run input when no `payload` field is sent, `null` when the run carries no input).
   */
  override execute(
    request: GraphNodeExecutionRequest<WebhookTriggerInput>
  ): GraphExecutionValues {
    // The declared schema is enforced on what was delivered.
    return {
      payload: assertTriggerPayload(
        "Webhook",
        triggerRunPayload(request.inputs, ["schema"]),
        this.schema ?? request.inputs["schema"]
      ),
    };
  }

  /** Body shape declaration for the received request, authored via the model-builder UI. */
  @required()
  @input({ handle: "schema" })
  @uielement("ngx-decaf-model-builder", {
    label: "graph.node.trigger.webhook.fields.schema.label",
    placeholder: "graph.node.trigger.webhook.fields.schema.placeholder",
  })
  schema?: unknown;

  /** Output carrying the received HTTP request payload. */
  @required()
  @output({ handle: "payload" })
  payload!: unknown;
}
