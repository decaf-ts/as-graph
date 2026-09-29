/**
 * @module as-graph/errors/GraphCycleError
 * @summary Error thrown when a workflow contains an unsupported cycle.
 * @description Ordinary (non-loop) workflow graphs must be acyclic. This error is raised when the planner detects a cycle.
 */
import { GraphExecutionError } from "./GraphExecutionError";

/**
 * Thrown when a graph workflow contains an unsupported cycle.
 */
export class GraphCycleError extends GraphExecutionError {
  constructor(details?: unknown) {
    super(
      "Graph workflow contains an unsupported cycle",
      "GRAPH_CYCLE_ERROR",
      details
    );
  }
}
