/**
 * @module as-graph/errors/GraphExecutionError
 * @summary Base error for all graph execution failures.
 * @description Extends Decaf's {@link InternalError} so graph errors follow the standard Decaf error hierarchy while carrying a graph-specific string code.
 */
import { InternalError } from "@decaf-ts/db-decorators";

/**
 * Base error for the graph execution engine.
 *
 * Extends `InternalError` (HTTP 500) to comply with the Decaf constitution which
 * requires runtime errors to be `BaseError` subclasses. The additional
 * `graphCode` property carries a machine-readable string code such as
 * `"GRAPH_CYCLE_ERROR"`.
 */
export class GraphExecutionError extends InternalError {
  readonly graphCode: string;
  readonly details?: unknown;

  constructor(
    message: string,
    graphCode = "GRAPH_EXECUTION_ERROR",
    details?: unknown
  ) {
    super(message, GraphExecutionError.name, 500);
    this.graphCode = graphCode;
    this.details = details;
    this.name = this.constructor.name;
  }
}
