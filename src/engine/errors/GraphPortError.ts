/**
 * @module as-graph/errors/GraphPortError
 * @summary Error thrown when a port reference is invalid.
 * @description Raised by the relation resolver or validator when a referenced port is missing or unknown.
 */
import { GraphExecutionError } from "./GraphExecutionError";

/**
 * Thrown when a port reference is invalid.
 */
export class GraphPortError extends GraphExecutionError {
  constructor(message: string, details?: unknown) {
    super(message, "GRAPH_PORT_ERROR", details);
  }
}
