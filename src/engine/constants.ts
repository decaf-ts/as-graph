/**
 * @module as-graph/engine/constants
 * @summary Graph execution engine-private constants and enums.
 * @description Engine-only constants, default limits, and enumerations.
 * Frontend-safe enums (`GraphExecutionStatus`, `GraphExecutionEventType`)
 * live in `@decaf-ts/as-graph/shared`; engine modules import shared
 * symbols from there and engine-private symbols from here.
 */

/**
 * Boundary identifier used as the node id for workflow-level input/output ports.
 */
export const GRAPH_WORKFLOW_BOUNDARY = "$workflow";

/**
 * Default concurrency for parallel node execution within a layer.
 */
export const GRAPH_DEFAULT_CONCURRENCY = 4;

/**
 * Default maximum iterations for `while` and `until` loop nodes.
 */
export const GRAPH_DEFAULT_MAX_LOOP_ITERATIONS = 100;

/**
 * Default maximum iterations for `foreach` loop nodes.
 */
export const GRAPH_DEFAULT_MAX_FOREACH_ITERATIONS = 1000;

/**
 * Metadata key under which pinning information is stored on a graph node.
 */
export const GRAPH_PINNING_METADATA_KEY = "graph.pinnable";

/**
 * Pinning strategy determining when values are pinned.
 */
export enum GraphPinningStrategy {
  MANUAL = "manual",
  AUTOMATIC = "automatic",
  DISABLED = "disabled",
}

/**
 * Built-in condition types supported by the loop condition evaluator.
 */
export enum GraphConditionType {
  TRUTHY = "truthy",
  FALSY = "falsy",
  EQUALS = "equals",
  NOT_EQUALS = "notEquals",
  GREATER_THAN = "greaterThan",
  GREATER_THAN_OR_EQUAL = "greaterThanOrEqual",
  LESS_THAN = "lessThan",
  LESS_THAN_OR_EQUAL = "lessThanOrEqual",
  EXISTS = "exists",
  CUSTOM = "custom",
}

/**
 * Loop node kinds recognised by the engine.
 */
export const GRAPH_LOOP_KIND = {
  FOREACH: "core.loop.foreach",
  WHILE: "core.loop.while",
  UNTIL: "core.loop.until",
} as const;
