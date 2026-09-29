/**
 * @module as-graph/errors/GraphBreakSignal
 * @summary Control-flow signal used by `core.flow.break` to exit a loop early.
 * @description Thrown by the Break node executor and caught by the enclosing
 * loop executor (`core.loop.foreach`, `core.loop.while`, `core.loop.until`).
 * Unlike a real error, a break signal is a cooperative control-flow token: it
 * is NOT propagated as a workflow failure. When caught, the loop terminates
 * early and returns the results collected so far (plus the optional `value`
 * carried by the signal as the final partial result).
 */
import { GraphExecutionError } from "./GraphExecutionError";

/**
 * Control-flow signal thrown by `core.flow.break` nodes.
 *
 * Extends {@link GraphExecutionError} so it rides on the existing error
 * pipeline, but carries the `graphCode` `"GRAPH_BREAK_SIGNAL"` and the flag
 * `isBreakSignal = true` so loop executors can distinguish it from a genuine
 * execution failure via `instanceof` or the flag.
 */
export class GraphBreakSignal extends GraphExecutionError {
  /** Distinguishes a break signal from a genuine error without `instanceof`. */
  readonly isBreakSignal = true;

  /**
   * @param value - Optional value forwarded by the Break node. The enclosing
   *   loop appends this to the collected results as the last partial result.
   */
  constructor(value?: unknown) {
    super("Break signal", "GRAPH_BREAK_SIGNAL", { value });
    this.name = "GraphBreakSignal";
  }
}
