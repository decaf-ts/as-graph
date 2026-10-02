/**
 * @module as-graph/nodes/triggers/event
 * @summary Event trigger node declaration (DECAF-32 §22.2.1).
 * @description Event trigger — internal event bus topic subscriber.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the event trigger (none — it is an entrypoint). */
export type EventTriggerInput = Record<string, unknown>;

/** Outputs produced by the event trigger. */
export interface EventTriggerOutput {
  payload: unknown;
}

/**
 * Event trigger node: internal event-bus topic subscriber.
 */
@node("core.trigger.event", {
  kind: "core.trigger.event",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-broadcast",
  width: 96,
  height: 96,
  labels: ["trigger", "event", "bus"],
  metadata: {
    title: "graph.node.trigger.event.name",
    description:
      "graph.node.trigger.event.description",
    trigger: {
      type: "event",
      topic: "default",
    },
  },
})
@model()
export class EventTriggerNode extends GraphNode<
  EventTriggerInput,
  EventTriggerOutput
> {
  /**
   * Returns the event-bus payload supplied by the run caller.
   *
   * @param {GraphNodeExecutionRequest<EventTriggerInput>} request - Execution request carrying the event payload.
   * @return {GraphExecutionValues} The `payload` output value (null when absent).
   */
  override execute(
    request: GraphNodeExecutionRequest<EventTriggerInput>
  ): GraphExecutionValues {
    return { payload: request.inputs["payload"] ?? null };
  }

  /** Output carrying the event-bus topic payload. */
  @required()
  @output({ handle: "payload" })
  payload!: unknown;
}
