/**
 * @module as-graph/engine/services/GraphEnvironment
 * @summary Backend graph environment accumulating the shared logging environment.
 * @description The backend graph environment extends/accumulates the shared
 * `@decaf-ts/logging` environment ({@link LoggedEnvironment}) with the
 * graph-specific options every backend graph service consumes. Services read their
 * options from this environment — never from injectable config objects — so hosts
 * configure behaviour through environment variables / the accumulated environment.
 */
import { LoggedEnvironment } from "@decaf-ts/logging";
import {
  DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS,
  type GraphWorkflowDocumentLimits,
} from "../validation/GraphWorkflowDocumentLimits";
import { GRAPH_CODE_MAX_TIMEOUT_MS } from "../constants";

/** Options for {@link GraphWorkflowService}: backend-enforced document resource limits. */
export interface GraphWorkflowServiceOptions {
  /** Backend-enforced resource limits for submitted documents (§4.16). */
  limits?: GraphWorkflowDocumentLimits;
  /**
   * Explicit DECAF-48 §4.15 standalone tolerance: when `true`, anonymous
   * callers are tolerated on owned workflows. Defaults to `false` —
   * ownership checks fail closed for absent identities (SAA-595 F3).
   */
  allowAnonymousAccess?: boolean;
}

/**
 * Backend-enforced execution limits, resolved from the accumulated graph
 * environment at execution time. These are hard ceilings: a node-level value can
 * never exceed them.
 */
export interface GraphExecutionServiceOptions {
  /**
   * Hard ceiling, in milliseconds, for the Code node's user-controllable sandbox
   * `timeoutMs`. Defaults to {@link GRAPH_CODE_MAX_TIMEOUT_MS}.
   */
  maxCodeTimeoutMs?: number;
}

/** Accumulated shape of the backend graph environment. */
export interface GraphEnvironmentOptions {
  graph: {
    workflows: Required<GraphWorkflowServiceOptions>;
    execution?: GraphExecutionServiceOptions;
  };
}

/**
 * Backend graph environment: accumulates {@link LoggedEnvironment} (which in turn
 * accumulates the shared logging environment) and adds the graph service options.
 */
export const GraphEnvironment = LoggedEnvironment.accumulate<GraphEnvironmentOptions>({
  graph: {
    workflows: {
      limits: { ...DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS },
      allowAnonymousAccess: false,
    },
    execution: {
      maxCodeTimeoutMs: GRAPH_CODE_MAX_TIMEOUT_MS,
    },
  },
});
