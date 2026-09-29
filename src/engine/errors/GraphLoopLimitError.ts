/**
 * @module as-graph/errors/GraphLoopLimitError
 * @summary Error thrown when a loop exceeds its maximum iterations.
 * @description Raised by loop executors when the iteration count reaches the configured safety limit.
 */
import { GraphExecutionError } from "./GraphExecutionError";

/**
 * Thrown when a loop exceeds its maximum iterations.
 */
export class GraphLoopLimitError extends GraphExecutionError {
  constructor(message: string, details?: unknown) {
    super(message, "GRAPH_LOOP_LIMIT_ERROR", details);
  }
}
