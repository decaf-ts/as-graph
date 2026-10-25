/**
 * @module as-graph/nodes/triggers/workflow
 * @summary Workflow lifecycle trigger node declaration (Stage 5b).
 * @description Workflow trigger — starts the workflow on its own lifecycle
 * events (`activate`, `update`), matching n8n's `workflowTrigger` node. n8n's
 * `executeWorkflowTrigger` is a different node (a callable sub-workflow entry
 * point) and is already covered by `core.trigger.executeWorkflow`; this kind
 * exists because that one does not express lifecycle events.
 *
 * The host's workflow lifecycle plumbing delivers the event through the
 * `event` input (or an already-built `payload`). When no event is delivered,
 * the first configured event is assumed, so a run started through the run
 * service still has deterministic behaviour. A delivered event that is not in
 * the configured `events` list fails closed, exactly as n8n would not fire.
 * The emitted payload keeps n8n's field names (`event`, `timestamp`,
 * `workflow_id`) alongside the normalized `activate`/`update` value.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { asRecord } from "../../storage/support";

/** Lifecycle events the workflow trigger can listen to. */
export type WorkflowTriggerEvent = "activate" | "update";

/** Inputs accepted by the workflow trigger. */
export type WorkflowTriggerInput = Record<string, unknown>;

/** Outputs produced by the workflow trigger. */
export interface WorkflowTriggerOutput {
  payload: unknown;
  event?: WorkflowTriggerEvent;
  timestamp?: string;
  workflowId?: string;
}

/** Human-readable event labels kept for n8n payload compatibility. */
const EVENT_LABELS: Record<WorkflowTriggerEvent, string> = {
  activate: "Workflow activated",
  update: "Workflow updated",
};

/** Normalizes a delivered event name to the internal event value. */
function normalizeEvent(value: unknown): WorkflowTriggerEvent | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "activate" || normalized === "workflow activated")
    return "activate";
  if (normalized === "update" || normalized === "workflow updated")
    return "update";
  return undefined;
}

/** Normalizes the configured `events` value (array or comma-separated string). */
function configuredEvents(value: unknown): WorkflowTriggerEvent[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const events = raw
    .map((entry) => normalizeEvent(entry))
    .filter((entry): entry is WorkflowTriggerEvent => entry !== undefined);
  return events.length ? events : ["activate"];
}

/**
 * Workflow trigger node: emits a workflow lifecycle event into the run.
 */
@node("core.trigger.workflow", {
  kind: "core.trigger.workflow",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-git-branch",
  width: 96,
  height: 96,
  labels: ["trigger", "workflow", "lifecycle", "activate", "update"],
  metadata: {
    title: "graph.node.trigger.workflow.name",
    description: "graph.node.trigger.workflow.description",
    trigger: {
      type: "workflow",
      events: ["activate"],
    },
  },
})
@model()
export class WorkflowTriggerNode extends GraphNode<
  WorkflowTriggerInput,
  WorkflowTriggerOutput
> {
  /**
   * Emits the lifecycle payload for the delivered (or configured) event.
   *
   * @param request - The execution request carrying the delivered event/payload.
   * @returns The lifecycle payload plus the normalized event, timestamp, and workflow id.
   * @throws {GraphExecutionError} `GRAPH_WORKFLOW_TRIGGER_EVENT_INVALID` for an
   *   unrecognized delivered event and `GRAPH_WORKFLOW_TRIGGER_EVENT_NOT_CONFIGURED`
   *   when the delivered event is not enabled on the node.
   */
  override execute(
    request: GraphNodeExecutionRequest<WorkflowTriggerInput>
  ): GraphExecutionValues {
    const delivered = this.payload ?? request.inputs["payload"];
    const payloadRecord = asRecord(delivered);
    const deliveredEvent =
      this.event ??
      request.inputs["event"] ??
      payloadRecord?.["event"] ??
      payloadRecord?.["workflow_event"];
    const events = configuredEvents(this.events);
    const event = deliveredEvent === undefined
      ? events[0]
      : normalizeEvent(deliveredEvent);
    if (!event) {
      throw new GraphExecutionError(
        `Workflow trigger received an unsupported event '${String(
          deliveredEvent
        )}'`,
        "GRAPH_WORKFLOW_TRIGGER_EVENT_INVALID",
        { event: deliveredEvent }
      );
    }
    if (!events.includes(event)) {
      throw new GraphExecutionError(
        `Workflow trigger is not configured for the '${event}' event`,
        "GRAPH_WORKFLOW_TRIGGER_EVENT_NOT_CONFIGURED",
        { event, events }
      );
    }

    const timestamp =
      (this.timestamp as string | undefined) ??
      (request.inputs["timestamp"] as string | undefined) ??
      (typeof payloadRecord?.["timestamp"] === "string"
        ? (payloadRecord["timestamp"] as string)
        : undefined) ??
      new Date().toISOString();
    const workflowId =
      (this.workflowId as string | undefined) ??
      (request.inputs["workflowId"] as string | undefined) ??
      (typeof payloadRecord?.["workflow_id"] === "string"
        ? (payloadRecord["workflow_id"] as string)
        : undefined);

    const payload =
      payloadRecord ??
      {
        event: EVENT_LABELS[event],
        timestamp,
        ...(workflowId ? { workflow_id: workflowId } : {}),
      };
    return {
      payload,
      event,
      timestamp,
      ...(workflowId ? { workflowId } : {}),
    };
  }

  /** Lifecycle events that start the workflow. */
  @required()
  @input({ handle: "events", userControlled: true, type: "array" })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.workflow.fields.events.label",
    type: "select",
  })
  events: WorkflowTriggerEvent[] = ["activate"];

  /** Delivered lifecycle event (from the host's workflow lifecycle plumbing). */
  @input({ handle: "event" })
  event?: unknown;

  /** Already-built lifecycle payload delivered by the host (optional). */
  @input({ handle: "payload", type: "object" })
  payload?: unknown;

  /** Delivered lifecycle timestamp (defaults to now). */
  @input({ handle: "timestamp" })
  timestamp?: unknown;

  /** Delivered workflow id (optional). */
  @input({ handle: "workflowId" })
  workflowId?: unknown;

  /** The lifecycle payload (n8n-compatible fields). */
  @required()
  @output({ handle: "payload", type: "object" })
  payloadOut!: unknown;

  /** The normalized lifecycle event. */
  @output({ handle: "event" })
  eventOut?: WorkflowTriggerEvent;

  /** The lifecycle event timestamp. */
  @output({ handle: "timestamp" })
  timestampOut?: string;

  /** The triggering workflow id, when delivered. */
  @output({ handle: "workflowId" })
  workflowIdOut?: string;
}
