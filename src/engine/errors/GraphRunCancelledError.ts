import { GraphExecutionError } from "./GraphExecutionError";

/**
 * Thrown when a graph run is cancelled before completion: carries the run id
 * under the `GRAPH_RUN_CANCELLED` code so run lifecycle bookkeeping can
 * distinguish cancellation from failure.
 */
export class GraphRunCancelledError extends GraphExecutionError {
  constructor(runId: string) {
    super(
      `Graph run '${runId}' was cancelled`,
      "GRAPH_RUN_CANCELLED",
      { runId }
    );
    this.name = GraphRunCancelledError.name;
  }
}
