/**
 * @module as-graph/errors/GraphPinningError
 * @summary Error thrown when a pinning operation fails.
 * @description Raised when a node cannot be pinned, e.g. because an upstream dependency is not pinnable.
 */
import { GraphExecutionError } from "./GraphExecutionError";

/**
 * Thrown when a pinning operation fails.
 */
export class GraphPinningError extends GraphExecutionError {
  constructor(message: string, details?: unknown) {
    super(message, "GRAPH_PINNING_ERROR", details);
  }
}
