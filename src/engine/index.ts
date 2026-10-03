/**
 * @module as-graph/engine
 * @summary Graph execution engine (backend-only).
 * @description Reference interpreter for Decaf graph workflows. Executes
 * workflows declared with `@decaf-ts/as-graph/shared`, emits events
 * through Decaf's Observable pipeline, supports structured loops, configurable
 * value stores, and pinnable/cacheable nodes. Frontend-safe shared
 * declarations live in `@decaf-ts/as-graph/shared`.
 */
export * from "./constants";
export * from "./types";
export * from "./decorators";

export * from "./errors/GraphExecutionError";
export * from "./errors/GraphCycleError";
export * from "./errors/GraphInputError";
export * from "./errors/GraphLoopLimitError";
export * from "./errors/GraphPinningError";
export * from "./errors/GraphPortError";
export * from "./errors/GraphStoreError";
export * from "./errors/GraphTopologyError";
export * from "./errors/GraphBreakSignal";
export * from "./errors/GraphRunCancelledError";
export * from "./errors/GraphWorkflowErrors";

export * from "./events/GraphExecutionObserver";
export * from "./events/GraphExecutionEventEmitter";
export * from "./events/GraphExecutionEventFactory";

export * from "./auth";

export * from "./execution/GraphExecutionContext";
export * from "./execution/GraphNodeExecutor";
export * from "./execution/GraphExecutionFrame";
export * from "./execution/GraphExecutionResult";
export * from "./execution/GraphExecutionEngine";
export * from "./execution/CodeSandboxEvaluator";
export * from "./execution/IsolatedVmCodeSandboxEvaluator";

export * from "./registry/GraphNodeExecutorRegistry";
export * from "./registry/GraphNodeExecutorResolver";

export * from "./catalog";

export * from "./store/GraphValueKey";
export * from "./store/GraphCachedValue";
export * from "./store/GraphValueModel";
export * from "./store/GraphValueRepository";

export * from "./planning/GraphExecutionPlanNode";
export * from "./planning/GraphExecutionPlanEdge";
export * from "./planning/GraphExecutionPlanLayer";
export * from "./planning/GraphExecutionPlan";
export * from "./planning/GraphExecutionPlanner";
export * from "./planning/GraphTopology";

// Validation (TASK-215; DECAF-50 §4.8 nine-stage document validation gate)
export * from "./validation";

// Loops (TASK-216)
export * from "./loops/GraphConditionEvaluator";
export * from "./loops/ConditionEvaluator";
export * from "./loops/ConditionExpressionEvaluator";
export * from "./loops/GraphLoopExecutionContext";

// Pinning (TASK-217/218)
export * from "./pinning/GraphPinningMetadata";
export * from "./pinning/GraphPinningPolicy";
export * from "./pinning/GraphPinningDependencyResolver";
export * from "./pinning/GraphPinningService";

// Run lifecycle (DECAF-50 §4.14–§4.16)
export * from "./runs";

// Nest-agnostic backend services (options resolved from the graph environment)
export * from "./services/GraphEnvironment";
export * from "./services/GraphWorkflowService";
export * from "./services/GraphRunModelService";

// Snapshots (TASK-219)
export * from "./snapshots/GraphExecutionSnapshotMapper";
