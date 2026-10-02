/**
 * @module as-graph/nodes/triggers/manual
 * @summary Manual trigger node declaration (DECAF-32 §22.2.1).
 * @description Manual trigger — user clicks Run. A payloadless trigger:
 * the node declares no `@uielement` configuration field, because there is
 * nothing to configure on the canvas beyond the run action. Its `payload`
 * `@output` port carries the runtime trigger payload supplied by the run caller.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the manual trigger (none — it is payloadless). */
export type ManualTriggerInput = Record<string, unknown>;

/** Outputs produced by the manual trigger. */
export interface ManualTriggerOutput {
  payload: unknown;
}

/**
 * Manual trigger node: user-started run. Payloadless — it exposes only the
 * runtime `payload` output.
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
    title: "graph.node.trigger.manual.name",
    description:
      "graph.node.trigger.manual.description",
    trigger: {
      type: "manual",
      inputSchema: {},
    },
  },
})
@model()
export class ManualTriggerNode extends GraphNode<
  ManualTriggerInput,
  ManualTriggerOutput
> {
  /**
   * Returns the runtime trigger payload supplied by the run caller.
   *
   * @param {GraphNodeExecutionRequest<ManualTriggerInput>} request - Execution request carrying the manual trigger payload.
   * @return {GraphExecutionValues} The `payload` output value (null when absent).
   */
  override execute(
    request: GraphNodeExecutionRequest<ManualTriggerInput>
  ): GraphExecutionValues {
    return { payload: request.inputs["payload"] ?? null };
  }

  /** Output carrying the runtime trigger payload from the run caller. */
  @required()
  @output({ handle: "payload" })
  payload!: unknown;
}
