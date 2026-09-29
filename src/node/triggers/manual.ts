/**
 * @module as-graph/nodes/triggers/manual
 * @summary Manual trigger node declaration (DECAF-32 §22.2.1).
 * @description Manual trigger — user clicks Run; input form generated from
 * `inputSchema`. Triggers are metadata-only entrypoints: they define how a
 * workflow starts and produce a trigger payload on their `@output` ports.
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
 * Manual trigger node: user-started run whose input form is generated from `inputSchema`.
 */
@node("core.trigger.manual", {
  kind: "core.trigger.manual",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-hand-click",
  width: 96,
  height: 96,
  labels: ["trigger", "manual", "entrypoint"],
  metadata: {
    title: "Manual trigger",
    description:
      "Starts the workflow when the user clicks Run. The input form is generated from the trigger's input schema.",
    trigger: {
      type: "manual",
      inputSchema: {},
    },
  },
})
@model()
export class ManualTriggerNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return { payload: request.inputs["payload"] ?? null };
  }

  @required()
  @uielement("textarea", {
    label: "Trigger payload",
    placeholder: "Manual trigger payload",
  })
  @output({ handle: "payload" })
  payload!: unknown;
}
