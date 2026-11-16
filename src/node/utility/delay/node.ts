/**
 * @module as-graph/nodes/utility/delay
 * @summary Delay utility node declaration (DECAF-32 §22.2.2).
 * @description Delay — pauses execution for a configured duration. The node
 * carries exactly one configuration property (`timeoutMs`), one input, and one
 * output; it always forwards its input unchanged (passthrough).
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode, graphDefaultInput } from "../../base";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { GRAPH_DELAY_MAX_MS } from "../../../engine/constants";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the delay node. */
export type DelayFlowInput = Record<string, unknown>;

/** Outputs produced by the delay node. */
export interface DelayFlowOutput {
  value: unknown;
}

/**
 * Clamps a requested delay to the engine ceiling.
 *
 * @param requested - The configured `timeoutMs` value.
 * @param maxDelayMs - The ceiling. Defaults to {@link GRAPH_DELAY_MAX_MS}.
 * @returns The delay to wait, `0` when the request is not a positive number.
 */
export function clampGraphDelayMs(
  requested: unknown,
  maxDelayMs: number = GRAPH_DELAY_MAX_MS
): number {
  const value = typeof requested === "string" ? Number(requested) : requested;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), maxDelayMs);
}

/**
 * Waits `delayMs`, rejecting as soon as the run is aborted.
 *
 * @param delayMs - The time to wait, in milliseconds.
 * @param signal - The run's abort signal, when it has one.
 * @returns A promise settled when the delay elapsed.
 * @throws {GraphExecutionError} `GRAPH_DELAY_ABORTED` when `signal` aborts first.
 */
export function waitForGraphDelay(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const aborted = (): GraphExecutionError =>
      new GraphExecutionError(
        "Delay node was aborted before its wait elapsed",
        "GRAPH_DELAY_ABORTED",
        { delayMs }
      );
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Delay utility node: pauses execution for a configured duration.
 */
@node("core.flow.delay", {
  kind: "core.flow.delay",
  category: "Utility",
  color: "#0d9488",
  icon: "ti-clock-hour-4",
  width: 96,
  height: 96,
  labels: ["flow", "delay", "wait"],
  metadata: {
    title: "graph.node.utility.delay.name",
    description:
      "graph.node.utility.delay.description",
  },
})
@model()
export class DelayFlowNode extends GraphNode<DelayFlowInput, DelayFlowOutput> {
  /**
   * Waits for the configured duration, then forwards the input unchanged.
   *
   * The wait is clamped to {@link GRAPH_DELAY_MAX_MS} and follows the run's
   * abort signal: a cancelled run stops waiting immediately and fails with
   * `GRAPH_DELAY_ABORTED` instead of holding its worker until the timer
   * fires. A missing, non-numeric, or non-positive `timeoutMs` does not wait.
   *
   * @param {GraphNodeExecutionRequest<DelayFlowInput>} request - Execution request carrying the `value` input.
   * @param {GraphExecutionContext} context - Run-scoped context supplying the abort signal.
   * @return {Promise<GraphExecutionValues>} The unchanged input value under `value`.
   * @throws {GraphExecutionError} `GRAPH_DELAY_ABORTED` when the run is cancelled during the wait.
   */
  override async execute(
    request: GraphNodeExecutionRequest<DelayFlowInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const delayMs = clampGraphDelayMs(this.timeoutMs);
    if (delayMs > 0) {
      await waitForGraphDelay(delayMs, context?.abortSignal);
    }
    return { value: graphDefaultInput(request.inputs) };
  }

  /** Input value forwarded unchanged after the delay. */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Delay duration in milliseconds enforced around this node's execution. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.utility.delay.fields.timeoutMs.label",
    type: "number",
  })
  @input({ handle: "timeoutMs", userControlled: true, type: "number" })
  timeoutMs?: number;

  /** Output carrying the unchanged input value. */
  @required()
  @output({ handle: "value" })
  valueOut!: unknown;
}
