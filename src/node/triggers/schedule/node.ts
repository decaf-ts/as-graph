/**
 * @module as-graph/nodes/triggers/schedule
 * @summary Schedule trigger node declaration (DECAF-32 §22.2.1).
 * @description Schedule trigger — cron-like schedule; the `cron` property is
 * mapped to the for-angular Cron input (`ngx-decaf-cron-selector`). Timezone and
 * payload remain trigger metadata.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the schedule trigger (none — it is an entrypoint). */
export type ScheduleTriggerInput = Record<string, unknown>;

/** Outputs produced by the schedule trigger. */
export interface ScheduleTriggerOutput {
  payload: unknown;
}

/**
 * Schedule trigger node: cron-like schedule with timezone and payload configuration.
 */
@node("core.trigger.schedule", {
  kind: "core.trigger.schedule",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-calendar-time",
  width: 96,
  height: 96,
  labels: ["trigger", "schedule", "cron"],
  metadata: {
    title: "graph.node.trigger.schedule.name",
    description:
      "graph.node.trigger.schedule.description",
    trigger: {
      type: "schedule",
      schedule: "0 * * * *",
      timezone: "UTC",
    },
  },
})
@model()
export class ScheduleTriggerNode extends GraphNode<
  ScheduleTriggerInput,
  ScheduleTriggerOutput
> {
  /**
   * Returns the scheduled-run payload supplied by the run caller.
   *
   * @param {GraphNodeExecutionRequest<ScheduleTriggerInput>} request - Execution request carrying the scheduled-run payload.
   * @return {GraphExecutionValues} The `payload` output value (null when absent).
   */
  override execute(
    request: GraphNodeExecutionRequest<ScheduleTriggerInput>
  ): GraphExecutionValues {
    return { payload: request.inputs["payload"] ?? null };
  }

  /** Cron expression driving the schedule; rendered with the cron-selector UI. */
  @required()
  @input({ handle: "cron" })
  @uielement("app-cron-selector-field", {
    label: "graph.node.trigger.schedule.fields.cron.label",
    placeholder: "graph.node.trigger.schedule.fields.cron.placeholder",
  })
  cron?: string;

  /** Output carrying the scheduled-run payload. */
  @required()
  @output({ handle: "payload" })
  payload!: unknown;
}
