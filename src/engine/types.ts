/**
 * @module as-graph/engine/types
 * @summary Graph execution engine core types.
 * @description Engine-private type aliases and interfaces. Frontend-safe
 * types (`ExprValue`, `ConditionExpression`, `CodeCondition`,
 * `SwitchCaseCondition`, `SwitchCase`, `SwitchNodeMetadata`,
 * `NodeMetadataChange`, `GraphExecutionEvent`, `GraphExecutionErrorPayload`)
 * live in `@decaf-ts/as-graph/shared`; engine modules import shared
 * symbols from there and engine-private symbols from here.
 */
import type {
  GraphCredentialReference,
  GraphJsonValue,
  GraphNodeInstance,
  GraphWorkflowDocument,
} from "../shared/graph";

import type { GraphResolvedNodeManifest } from "../shared/graph";

import type { GraphExecutionStatus } from "../shared/graph";
import type {
  Condition,
  GraphExecutionErrorPayload,
  GraphExecutionEvent,
} from "../shared/graph";
import type { GraphAuthData } from "./auth/GraphAuth";

/**
 * Unique identifier for a single graph execution run.
 */
export type GraphRunId = string;

/**
 * Identifier for a workflow definition.
 */
export type GraphWorkflowId = string;

/**
 * Identifier for a node within a workflow.
 */
export type GraphNodeId = string;

/**
 * Name of a port on a node or workflow boundary.
 */
export type GraphPortName = string;

/**
 * A bag of named values exchanged between nodes and the workflow boundary.
 */
export type GraphExecutionValues = Record<string, unknown>;

/**
 * Options that influence a single execution of a workflow.
 */
export interface GraphExecutionOptions {
  runId?: GraphRunId;
  parentRunId?: GraphRunId;
  workflowId?: GraphWorkflowId;
  path?: string[];
  concurrency?: number;
  failFast?: boolean;
  validateInputs?: boolean;
  validateOutputs?: boolean;
  maxLoopIterations?: number;
  maxForeachIterations?: number;
  usePinnedValues?: boolean;
  writeThroughCache?: boolean;
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  /**
   * Authenticated principal facts for this run. When omitted, the engine reads
   * them from the Decaf execution context (bound by the host `AuthHandler`).
   * Explicit values win over context-derived ones. Used to authorize the
   * workflow and each node before execution, and bound to the execution logger.
   */
  auth?: GraphAuthData;
}

/**
 * Effective engine execution limits exposed to node executors for a run. A
 * node-level value can never exceed these bounds; loop nodes clamp their own
 * `maxIterations` against them.
 */
export interface GraphExecutionLimits {
  /** Maximum iterations a `while` / `until` loop may execute. */
  maxLoopIterations: number;
  /** Maximum iterations a `foreach` loop may execute. */
  maxForeachIterations: number;
}

/**
 * Result of executing a single node.
 */
export interface GraphNodeExecutionResult {
  nodeId: GraphNodeId;
  status: GraphExecutionStatus;
  inputs: GraphExecutionValues;
  outputs?: GraphExecutionValues;
  error?: GraphExecutionErrorPayload;
  startedAt: Date;
  finishedAt?: Date;
  fromCache?: boolean;
  pinned?: boolean;
  events: GraphExecutionEvent[];
}

/**
 * Result of executing an entire workflow.
 *
 * The executed source of truth is the canonical {@link GraphWorkflowDocument}
 * (never a decorated workflow definition).
 */
export interface GraphExecutionResult {
  runId: GraphRunId;
  parentRunId?: GraphRunId;
  workflowId: GraphWorkflowId;
  status: GraphExecutionStatus;
  document: GraphWorkflowDocument;
  inputs: GraphExecutionValues;
  outputs: GraphExecutionValues;
  nodeResults: Record<GraphNodeId, GraphNodeExecutionResult>;
  events: GraphExecutionEvent[];
  startedAt: Date;
  finishedAt?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Credential references resolved for a node execution (DECAF-50 §4.9/§4.16).
 * Documents carry references only; secret material never enters the request.
 */
export type GraphResolvedCredentials = Record<string, GraphCredentialReference>;

/**
 * Request passed to request-based node executors (DECAF-50 §4.9).
 * Configuration (`parameters`, `credentials`, `metadata`) and input data
 * (`inputs`) are separated.
 *
 * @typeParam INPUT - The shape of the node's input values. Defaults to the
 *   generic {@link GraphExecutionValues} map; a node may narrow it to its own
 *   `@input`/`@output` shape for stricter typing.
 */
export interface GraphNodeExecutionRequest<
  INPUT = GraphExecutionValues,
> {
  nodeId: string;
  kind: string;
  inputs: INPUT;
  parameters: Record<string, GraphJsonValue>;
  credentials: GraphResolvedCredentials;
  metadata?: Record<string, GraphJsonValue>;
}

/**
 * Options used to construct a {@link GraphExecutionContext}.
 */
export interface GraphExecutionContextOptions {
  runId: GraphRunId;
  parentRunId?: GraphRunId;
  workflowId: GraphWorkflowId;
  document: GraphWorkflowDocument;
  node: GraphNodeInstance;
  manifest: GraphResolvedNodeManifest;
  path: string[];
  metadata?: Record<string, unknown>;
}

/**
 * A loop condition — a built-in `GraphConditionDefinition`, a graphical
 * `ConditionExpression`, or a code `CodeCondition`. The loop node classes accept
 * all three and dispatch them through {@link GraphConditionEvaluator}.
 */
export type LoopCondition = GraphConditionDefinition | Condition;

/**
 * Metadata describing a loop node's behaviour.
 */
export interface GraphLoopMetadata {
  /** The nested loop-body workflow document (DECAF-50 §4.9). */
  body: GraphWorkflowDocument;
  maxIterations?: number;
  timeoutMs?: number;
  condition?: LoopCondition;
  concurrency?: number;
  inputPort?: string;
  outputPort?: string;
  itemPort?: string;
  resultPort?: string;
  statePort?: string;
  /**
   * How many items are taken from the input list per iteration (foreach only).
   * Default `1`. When greater than `1`, the body receives a slice (array) on
   * the item port and the collected result is one entry per slice.
   */
  slice?: number;
}

/**
 * Definition of a condition evaluated by the loop condition evaluator.
 *
 * When the condition object carries an `op` field (see {@link ConditionExpression}),
 * the {@link GraphConditionEvaluator} dispatches to the {@link ConditionExpressionEvaluator};
 * when it carries `type: "code"` (see {@link CodeCondition}) it dispatches to the
 * registered `CodeSandboxEvaluator`; otherwise the built-in `type`-based switch is used.
 */
export interface GraphConditionDefinition {
  type:
    | "truthy"
    | "falsy"
    | "equals"
    | "notEquals"
    | "greaterThan"
    | "greaterThanOrEqual"
    | "lessThan"
    | "lessThanOrEqual"
    | "exists"
    | "custom";
  left?: string;
  right?: unknown;
  evaluator?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Pinning metadata attached to a node via `@pinnable()`.
 */
export interface GraphPinningMetadata {
  enabled: boolean;
  ttlMs?: number;
  strategy: "manual" | "automatic" | "disabled";
  includeDependencies: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Options for pinning a node after a completed run.
 */
export interface GraphPinNodeOptions {
  document: GraphWorkflowDocument;
  plan: unknown;
  result: GraphExecutionResult;
  nodeId: string;
  includeDependencies?: boolean;
  namespace?: string;
}

/**
 * Options for unpinning a node.
 */
export interface GraphUnpinNodeOptions {
  document: GraphWorkflowDocument;
  nodeId: string;
  fingerprint: string;
  namespace?: string;
}

/**
 * A patch applied to a graph workflow snapshot after execution.
 */
export interface GraphExecutionSnapshotPatch {
  runId: string;
  status: GraphExecutionStatus;
  nodes: Record<
    string,
    {
      status: GraphExecutionStatus;
      startedAt?: string;
      finishedAt?: string;
      error?: GraphExecutionErrorPayload;
      outputs?: Record<string, unknown>;
      fromCache?: boolean;
      pinned?: boolean;
    }
  >;
  edges: Record<
    string,
    {
      status: GraphExecutionStatus;
      lastValue?: unknown;
      updatedAt: string;
    }
  >;
  outputs: Record<string, unknown>;
  events: GraphExecutionEvent[];
}
