/**
 * @module as-graph/nodes/triggers/error
 * @summary Error trigger node declaration (Stage 5b).
 * @description Error trigger — entrypoint of an error workflow. The run/event
 * plumbing (a failed run's `workflow.failed` / `node.failed` events) delivers
 * the error context; this node normalizes it so the error workflow reads the
 * same three blocks n8n exposes: `execution` (id, url, retryOf,
 * lastNodeExecuted, mode, error), `workflow` (id, name), and the convenience
 * `error` projection. The node has no configuration; it is payloadless unless
 * the caller binds a `payload` input, in which case that payload passes
 * through unchanged. No engine-core change is needed: the failure payload
 * already flows through the existing event/run boundary.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { asRecord } from "../../storage/support";

/** Inputs accepted by the error trigger. */
export type ErrorTriggerInput = Record<string, unknown>;

/** Outputs produced by the error trigger. */
export interface ErrorTriggerOutput {
  payload: unknown;
  error?: unknown;
  execution?: unknown;
  workflow?: unknown;
}

/**
 * Error trigger node: emits the failed-run context into the error workflow.
 */
@node("core.trigger.error", {
  kind: "core.trigger.error",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-alert-triangle",
  width: 96,
  height: 96,
  labels: ["trigger", "error", "failure", "workflow"],
  metadata: {
    title: "graph.node.trigger.error.name",
    description: "graph.node.trigger.error.description",
    trigger: {
      type: "error",
    },
  },
})
@model()
export class ErrorTriggerNode extends GraphNode<
  ErrorTriggerInput,
  ErrorTriggerOutput
> {
  /**
   * Emits the delivered failure context.
   *
   * @param request - The execution request carrying the failure payload.
   * @returns The payload plus `execution`, `workflow`, and `error` projections
   *   when the delivered context carries them.
   */
  override execute(
    request: GraphNodeExecutionRequest<ErrorTriggerInput>
  ): GraphExecutionValues {
    const delivered =
      this.payload ??
      request.inputs["payload"] ??
      request.inputs["value"] ??
      request.inputs;
    const payload = asRecord(delivered) ?? { value: delivered };
    const execution =
      asRecord(payload["execution"]) ??
      asRecord(request.inputs["execution"]);
    const workflow =
      asRecord(payload["workflow"]) ?? asRecord(request.inputs["workflow"]);
    const error =
      asRecord(execution?.["error"]) ??
      asRecord(payload["error"]) ??
      asRecord(request.inputs["error"]);
    return {
      payload,
      ...(execution ? { execution } : {}),
      ...(workflow ? { workflow } : {}),
      ...(error ? { error } : {}),
    };
  }

  /** Failure context delivered by the run/event plumbing (optional). */
  @input({ handle: "payload", type: "object" })
  payload?: unknown;

  /** The delivered failure context. */
  @required()
  @output({ handle: "payload", type: "object" })
  payloadOut!: unknown;

  /** The failing execution block (`execution.error` carries the failure). */
  @output({ handle: "execution", type: "object" })
  execution?: unknown;

  /** The workflow that failed. */
  @output({ handle: "workflow", type: "object" })
  workflow?: unknown;

  /** Convenience projection of `execution.error` (or a top-level `error`). */
  @output({ handle: "error", type: "object" })
  error?: unknown;
}
