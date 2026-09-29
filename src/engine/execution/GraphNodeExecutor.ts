/**
 * @module as-graph/execution/GraphNodeExecutor
 * @summary Node executor contract (DECAF-50 §4.9, post-cutover).
 * @description The single executor contract: executors receive a
 * {@link GraphNodeExecutionRequest} that separates configuration
 * (`parameters`, `credentials`, `metadata`) from input data (`inputs`).
 * The §4.18 transition artifacts (legacy input-only contract, the
 * compatibility adapter, and the request-executor marker) were removed at
 * the P7 cutover.
 */
import type { GraphExecutionContext } from "./GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../types";

/**
 * Executor for a specific graph node kind (DECAF-50 §4.9 request contract).
 *
 * Implementations are registered in the {@link GraphNodeExecutorRegistry}
 * (a facade over the backend catalogue) and always receive the full
 * {@link GraphNodeExecutionRequest}; configuration and input data are
 * separated.
 */
export interface GraphNodeExecutor<
  Output extends GraphExecutionValues = GraphExecutionValues,
> {
  /**
   * Executes the node logic with configuration and input data separated.
   *
   * @param request - The node execution request (inputs, parameters,
   * credentials, metadata).
   * @param context - Decaf context for emitting progress and events.
   * @returns The node's output values keyed by port name.
   */
  execute(
    request: GraphNodeExecutionRequest,
    context: GraphExecutionContext
  ): Promise<Output> | Output;
}
