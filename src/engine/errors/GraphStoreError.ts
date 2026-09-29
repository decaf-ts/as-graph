/**
 * @module as-graph/errors/GraphStoreError
 * @summary Error thrown when a value store operation fails.
 * @description Raised by the value store or adapter when reading, writing, or deleting cached values fails.
 */
import { GraphExecutionError } from "./GraphExecutionError";

/**
 * Thrown when a value store operation fails.
 */
export class GraphStoreError extends GraphExecutionError {
  constructor(message: string, details?: unknown) {
    super(message, "GRAPH_STORE_ERROR", details);
  }
}
