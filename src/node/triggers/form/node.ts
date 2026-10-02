/**
 * @module as-graph/nodes/triggers/form
 * @summary Form trigger node declaration (DECAF-32 §22.2.1).
 * @description Form trigger — generated public/internal form; the submitted
 * shape is declared by the `schema` property (a `ModelBuilder`-produced model
 * rendered with the for-angular model-builder web component). The `payload`
 * output is a plain canvas port and is deliberately not a `@uielement`.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the form trigger (none — it is an entrypoint). */
export type FormTriggerInput = Record<string, unknown>;

/** Outputs produced by the form trigger. */
export interface FormTriggerOutput {
  payload: unknown;
}

/**
 * Form trigger node: generated public/internal form entrypoint with field definitions.
 */
@node("core.trigger.form", {
  kind: "core.trigger.form",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-forms",
  width: 96,
  height: 96,
  labels: ["trigger", "form", "public"],
  metadata: {
    title: "graph.node.trigger.form.name",
    description:
      "graph.node.trigger.form.description",
    trigger: {
      type: "form",
      fields: [],
    },
  },
})
@model()
export class FormTriggerNode extends GraphNode<
  FormTriggerInput,
  FormTriggerOutput
> {
  /**
   * Returns the submitted form payload supplied by the run caller.
   *
   * @param {GraphNodeExecutionRequest<FormTriggerInput>} request - Execution request carrying the submitted form payload.
   * @return {GraphExecutionValues} The `payload` output value (null when absent).
   */
  override execute(
    request: GraphNodeExecutionRequest<FormTriggerInput>
  ): GraphExecutionValues {
    return { payload: request.inputs["payload"] ?? null };
  }

  /** Field definitions for the generated form, authored via the model-builder UI. */
  @required()
  @input({ handle: "schema" })
  @uielement("ngx-decaf-model-builder", {
    label: "graph.node.trigger.form.fields.schema.label",
    placeholder: "graph.node.trigger.form.fields.schema.placeholder",
  })
  schema?: unknown;

  /** Output carrying the submitted form payload. */
  @required()
  @output({ handle: "payload" })
  payload!: unknown;
}
