/**
 * @module as-graph/errors/GraphInputError
 * @summary Error thrown when workflow or node inputs are invalid.
 * @description Raised by the value validator when required inputs are missing or fail schema validation.
 */
import { GraphExecutionError } from "./GraphExecutionError";

/**
 * Thrown when workflow or node inputs are invalid.
 */
export class GraphInputError extends GraphExecutionError {
  constructor(message: string, details?: unknown) {
    super(message, "GRAPH_INPUT_ERROR", details);
  }
}
