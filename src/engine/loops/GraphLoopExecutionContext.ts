/**
 * @module as-graph/loops/GraphLoopExecutionContext
 * @summary Context for loop node execution.
 * @description Carries loop-specific metadata and iteration state during loop execution.
 */
import type { GraphLoopMetadata } from "../types";

/**
 * Context for a single loop execution, carrying the loop metadata and
 * current iteration index.
 */
export class GraphLoopExecutionContext {
  readonly iteration: number;
  readonly metadata: GraphLoopMetadata;

  constructor(iteration: number, metadata: GraphLoopMetadata) {
    this.iteration = iteration;
    this.metadata = metadata;
  }
}
