/**
 * @module as-graph/errors/GraphTopologyError
 * @summary Error thrown when workflow topology is invalid.
 * @description Raised by the relation resolver or planner when an endpoint is unknown or ambiguous.
 */
import { GraphExecutionError } from "./GraphExecutionError";

/**
 * Thrown when workflow topology is invalid.
 */
export class GraphTopologyError extends GraphExecutionError {
  constructor(message: string, details?: unknown) {
    super(message, "GRAPH_TOPOLOGY_ERROR", details);
  }
}
