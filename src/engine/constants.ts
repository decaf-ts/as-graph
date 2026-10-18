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
 * Flavour under which the built-in {@link LocalGraphExecutionBackend} registers
 * itself in the {@link GraphExecutionBackendRegistry}.
 */
export const GRAPH_LOCAL_EXECUTION_BACKEND = "local";

/**
 * Machine code returned when the general (local) engine is asked to execute a
 * node kind that only the mastra engine can run (SAA-837 M1). The local backend
 * declares the mastra AI family unsupported and fails closed instead of
 * fabricating a result.
 */
export const GRAPH_LOCAL_UNSUPPORTED_NODE_KIND =
  "GRAPH_LOCAL_UNSUPPORTED_NODE_KIND";

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
 * Hard ceiling for `while` and `until` loop iterations. A node-level
 * `maxIterations` is clamped to the effective engine limit, which defaults to
 * this value and can be lowered (never raised above it) per run through
 * `GraphExecutionOptions.maxLoopIterations`.
 */
export const GRAPH_MAX_LOOP_ITERATIONS = 1000;

/**
 * Hard ceiling for `foreach` loop iterations. A node-level `maxIterations` is
 * clamped to the effective engine limit, which defaults to this value and can be
 * lowered (never raised above it) per run through
 * `GraphExecutionOptions.maxForeachIterations`.
 */
export const GRAPH_MAX_FOREACH_ITERATIONS = 10_000;

/**
 * Default hard ceiling, in milliseconds, for the Code node's user-controllable
 * sandbox `timeoutMs`. A node value is clamped to this bound unless a host
 * overrides it through `GraphEnvironment.graph.execution.maxCodeTimeoutMs`.
 */
export const GRAPH_CODE_MAX_TIMEOUT_MS = 30_000;

/**
 * Hard ceiling, in milliseconds, for the HTTP Request node's user-controllable
 * `timeoutMs`. Larger values are clamped (never trusted), bounding how long a
 * single workflow node can hold an execution open.
 */
export const GRAPH_HTTP_MAX_TIMEOUT_MS = 300_000;

/**
 * Maximum response body size, in bytes, that the HTTP Request node will read.
 * A larger body is rejected with `GRAPH_HTTP_RESPONSE_TOO_LARGE` instead of
 * buffering it in memory.
 */
export const GRAPH_HTTP_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum number of redirect hops the HTTP Request node follows. Every hop is
 * re-validated against the http/https allowlist so a redirect cannot pivot the
 * request to another protocol.
 */
export const GRAPH_HTTP_MAX_REDIRECTS = 5;

/**
 * Default maximum nesting depth of sub-workflow executions in one run. Depth is
 * tracked through the `parentRunId` chain and only `executeSubWorkflow`-style
 * edges increment it, so loop bodies stay governed by their own iteration caps.
 */
export const GRAPH_MAX_SUB_WORKFLOW_DEPTH = 10;

/**
 * Default maximum number of sub-workflow child runs a single root run may
 * spawn. Bounds unbounded `perItem` fan-out across the whole run tree.
 */
export const GRAPH_MAX_CHILD_RUNS = 1000;

/**
 * Maximum number of rows a data table may hold by default.
 */
export const GRAPH_DATA_TABLE_MAX_ROWS = 10_000;

/**
 * Maximum serialized size, in bytes, of a single data-table row payload.
 */
export const GRAPH_DATA_TABLE_MAX_ROW_BYTES = 1024 * 1024;

/**
 * Maximum number of rows a single data-table list operation returns.
 */
export const GRAPH_DATA_TABLE_MAX_LIST_ROWS = 10_000;

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
