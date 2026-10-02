/**
 * @module as-graph/execution/GraphExecutionEngine
 * @summary Reference graph execution engine (DECAF-50 §4.9).
 * @description Executes canonical {@link GraphWorkflowDocument}s. The public
 * `execute(document, inputs, options)` entrypoint performs resolution
 * internally: the document runs through the nine-stage §4.8 validation gate
 * (structured issue accumulation), is resolved against the trusted backend
 * catalogue into a {@link GraphResolvedWorkflow}, planned by the
 * {@link GraphExecutionPlanner} (resolved workflows only — never raw
 * definitions), and executed layer by layer. Node inputs are built from
 * routed edges, literal bindings, allowed expressions, manifest defaults,
 * and node parameters; configuration and input data are separated in the
 * {@link GraphNodeExecutionRequest}. Executor outputs are validated against
 * the effective output manifest. Disabled nodes follow the explicit
 * {@link GraphDisabledNodeBehavior} semantics. Events are emitted through
 * Decaf's Observable pipeline, including the DECAF-48 §4.4 visual-state
 * events and the `graph.run.log` run-log channel.
 */
import {
  Adapter,
  ClientBasedService,
  type Context,
  type ContextualArgs,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import type {
  GraphInputBinding,
  GraphJsonValue,
  GraphValueTemplate,
  GraphWorkflowDocument,
  GraphWorkflowPortInstance,
} from "../../shared/graph";

import {
  graphValueTemplateDefaultLanguage,
  isGraphValueTemplate,
} from "../../shared/graph";

import {
  GRAPH_DEFAULT_CONCURRENCY,
  GRAPH_MAX_FOREACH_ITERATIONS,
  GRAPH_MAX_LOOP_ITERATIONS,
  GRAPH_WORKFLOW_BOUNDARY,
} from "../constants";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
  GraphVisualState,
} from "../../shared/graph";
import {
  GraphBreakSignal,
  GraphExecutionError,
  GraphRunCancelledError,
} from "../errors";
import type {
  GraphExecutionErrorPayload,
  GraphExecutionEvent,
} from "../../shared/graph";
import type {
  GraphExecutionLimits,
  GraphExecutionOptions,
  GraphExecutionResult,
  GraphExecutionValues,
  GraphNodeExecutionRequest,
  GraphNodeExecutionResult,
  GraphPinNodeOptions,
  GraphResolvedCredentials,
  GraphRunId,
  GraphUnpinNodeOptions,
} from "../types";
import type { GraphExecutionObserver } from "../events/GraphExecutionObserver";
import { GraphExecutionEventEmitter } from "../events/GraphExecutionEventEmitter";
import { GraphExecutionEventFactory } from "../events/GraphExecutionEventFactory";
import type { GraphNodeExecutorRegistry } from "../registry/GraphNodeExecutorRegistry";
import type { GraphNodeCatalogue } from "../catalog/GraphNodeCatalogue";
import { GraphExecutionPlanner } from "../planning/GraphExecutionPlanner";
import type { GraphExecutionPlan } from "../planning/GraphExecutionPlan";
import type { GraphExecutionPlanNode } from "../planning/GraphExecutionPlanNode";
import type { GraphExecutionPlanEdge } from "../planning/GraphExecutionPlanEdge";
import {
  GraphWorkflowDocumentValidator,
  type GraphWorkflowDocumentValidationLimits,
} from "../validation/GraphWorkflowDocumentValidator";
import type { GraphCredentialAuthorizer } from "../validation/GraphCredentialReferenceValidator";
import {
  GraphParameterValidator,
  isGraphCredentialReferenceLike,
} from "../validation/GraphParameterValidator";
import { GraphDocumentValidationError } from "../validation/GraphValidationErrors";
import { createGraphValueRepository } from "../store/GraphValueRepository";
import type { GraphCachedValue } from "../store/GraphCachedValue";
import { GraphPinningService } from "../pinning/GraphPinningService";
import { GraphPinningPolicy } from "../pinning/GraphPinningPolicy";
import { GraphPinningDependencyResolver } from "../pinning/GraphPinningDependencyResolver";
import { GraphExecutionContext } from "./GraphExecutionContext";
import { GraphExecutionFrame } from "./GraphExecutionFrame";
import { buildGraphExecutionResult } from "./GraphExecutionResult";
import type { CodeSandboxEvaluator } from "./CodeSandboxEvaluator";
import {
  GraphAuthValidator,
  graphAuthDataOf,
  mergeGraphAuthData,
  type GraphNamespaceMatchOptions,
} from "../auth";

/**
 * Configuration for the {@link GraphExecutionEngine}.
 */
export interface GraphExecutionEngineConfig {
  registry: GraphNodeExecutorRegistry;
  /**
   * Trusted backend kind catalogue. Defaults to the registry facade's
   * catalogue; required for the nine-stage document validation gate.
   */
  catalogue?: GraphNodeCatalogue;
  /** Optional pre-configured document validator (overrides catalogue/limits). */
  documentValidator?: GraphWorkflowDocumentValidator;
  /** Backend-enforced document resource limits (§4.8 stage 1). */
  documentLimits?: GraphWorkflowDocumentValidationLimits;
  /** Pluggable credential existence/authorization hook (§4.8 stage 8). */
  credentialAuthorizer?: GraphCredentialAuthorizer;
  /**
   * Whether workflow/node namespace authorization is enforced. Defaults to
   * `false`: auth is optional. The NestJS module auto-enables it when a
   * Keycloak auth handler is configured.
   */
  authEnabled?: boolean;
  /**
   * Namespace decomposition comparison policy. Defaults to `inherit`: a broader
   * department grant covers a narrower sub-department requirement.
   */
  authMatch?: GraphNamespaceMatchOptions;
  planner?: GraphExecutionPlanner;
  /**
   * Decaf adapter backing cached/pinned value persistence. Defaults to the
   * globally configured adapter (`Adapter.current`); tests pass a `RamAdapter`
   * and production passes a durable adapter.
   */
  valueAdapter?: Adapter<any, any, any, any>;
  eventEmitter?: GraphExecutionEventEmitter;
  defaultOptions?: Partial<GraphExecutionOptions>;
  /**
   * Optional pluggable code sandbox evaluator for code-based conditions and
   * expression bindings (DECAF-32 §22.4). When absent, code conditions and
   * expression bindings throw `GRAPH_CODE_SANDBOX_NOT_CONFIGURED`.
   * Downstream projects (e.g. ALFRED) supply the actual VM sandbox
   * implementation.
   */
  codeSandboxEvaluator?: CodeSandboxEvaluator;
  /**
   * Optional callback invoked at the end of engine construction with the
   * fully-initialised engine instance. Use this to register executors that
   * need a back-reference to the engine (e.g. loop executors that execute
   * sub-workflows through the same engine).
   */
  onEngineCreated?: (
    engine: GraphExecutionEngine
  ) => void | Promise<void>;
}

/**
 * Runtime collaborators resolved by {@link GraphExecutionEngine.initialize}.
 */
export interface GraphExecutionEngineClient {
  /** Executor registry facade. */
  registry: GraphNodeExecutorRegistry;
  /** Trusted backend kind catalogue. */
  catalogue: GraphNodeCatalogue;
  /** Topological planner. */
  planner: GraphExecutionPlanner;
  /** Decaf adapter backing cached/pinned value persistence. */
  valueAdapter: Adapter<any, any, any, any>;
  /** Engine event emitter. */
  eventEmitter: GraphExecutionEventEmitter;
  /** Nine-stage document validator. */
  documentValidator: GraphWorkflowDocumentValidator;
  /** Workflow/node namespace + role authorizer. */
  authValidator: GraphAuthValidator;
  /** Optional pluggable code sandbox evaluator. */
  codeSandboxEvaluator?: CodeSandboxEvaluator;
}

/**
 * Compiles a `{{ ... }}` text template into a JavaScript template literal so
 * the pluggable code sandbox evaluator can resolve its placeholders against
 * the same `$input`/`$vars`/`$item` bindings used by expression bindings.
 *
 * @param template - The persisted template body.
 * @returns A backtick-quoted template literal expression.
 */
function graphTemplateToExpression(template: string): string {
  const escaped = template.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  const interpolated = escaped.replace(
    /\{\{\s*([\s\S]*?)\s*\}\}/g,
    (_match, expression: string) => `\${${expression}}`
  );
  return `\`${interpolated}\``;
}

/**
 * Reference graph execution engine.
 *
 * Executes a canonical {@link GraphWorkflowDocument} by:
 * 1. Validating it through the nine-stage gate and resolving it against the
 *    backend catalogue (§4.8).
 * 2. Planning the resolved workflow into topological layers (§4.9).
 * 3. Seeding workflow inputs into the value store.
 * 4. Executing nodes layer-by-layer with configurable concurrency, honouring
 *    disabled-node semantics.
 * 5. Building node inputs from routed edges, literal bindings, allowed
 *    expressions, and manifest defaults; keeping configuration (parameters,
 *    credentials) separate from input data.
 * 6. Validating executor outputs against the effective output manifest.
 * 7. Routing values along data edges.
 * 8. Emitting structured events through Decaf's Observable pipeline.
 * 9. Returning a complete {@link GraphExecutionResult}.
 */
export class GraphExecutionEngine
  extends ClientBasedService<
    GraphExecutionEngineClient,
    GraphExecutionEngineConfig
  >
{
  constructor() {
    super();
  }

  /**
   * Resolves the engine's configuration and runtime collaborators.
   *
   * `Service.boot` may call this with only a decaf `Context`; an explicit
   * `initialize(config)` is required before the engine can execute.
   *
   * @param args - The engine config, optionally followed by a decaf `Context`.
   * @returns The resolved config and runtime client bundle.
   */
  override async initialize(
    ...args: ContextualArgs<any>
  ): Promise<{
    config: GraphExecutionEngineConfig;
    client: GraphExecutionEngineClient;
  }> {
    const config = args[0] as GraphExecutionEngineConfig;
    if (!config || typeof config !== "object" || !config.registry) {
      this._config = undefined;
      this._client = undefined;
      return { config: undefined as never, client: undefined as never };
    }
    const catalogue = config.catalogue ?? config.registry.catalog;
    const valueAdapter = config.valueAdapter ?? Adapter.current;
    if (!valueAdapter) {
      throw new GraphExecutionError(
        "GraphExecutionEngine requires a Decaf adapter for cached/pinned values: pass `valueAdapter` or configure one via `Adapter.setCurrent(...)`",
        "GRAPH_VALUE_ADAPTER_MISSING"
      );
    }
    const client: GraphExecutionEngineClient = {
      registry: config.registry,
      catalogue,
      planner: config.planner ?? new GraphExecutionPlanner(),
      valueAdapter,
      eventEmitter: config.eventEmitter ?? new GraphExecutionEventEmitter(),
      documentValidator:
        config.documentValidator ??
        new GraphWorkflowDocumentValidator({
          catalogue,
          limits: config.documentLimits,
          credentialAuthorizer: config.credentialAuthorizer,
        }),
      authValidator: new GraphAuthValidator({
        enabled: config.authEnabled === true,
        ...(config.authMatch ? { match: config.authMatch } : {}),
      }),
      ...(config.codeSandboxEvaluator
        ? { codeSandboxEvaluator: config.codeSandboxEvaluator }
        : {}),
    };
    this._config = config;
    this._client = client;
    await config.onEngineCreated?.(this);
    return { config, client };
  }

  /** Pluggable code sandbox evaluator (§22.4); may be undefined. */
  get codeSandboxEvaluator(): CodeSandboxEvaluator | undefined {
    return this.client.codeSandboxEvaluator;
  }

  private get emitter(): GraphExecutionEventEmitter {
    return this.client.eventEmitter;
  }

  private get planner(): GraphExecutionPlanner {
    return this.client.planner;
  }

  private get valueAdapter(): Adapter<any, any, any, any> {
    return this.client.valueAdapter;
  }

  private get defaultOptions(): Partial<GraphExecutionOptions> {
    return this.config.defaultOptions ?? {};
  }

  private get documentValidator(): GraphWorkflowDocumentValidator {
    return this.client.documentValidator;
  }

  /**
   * Registers an observer on the engine's event pipeline.
   *
   * @param observer - The observer to register.
   * @returns An unsubscribe function that removes the observer.
   */
  override observe(observer: GraphExecutionObserver): () => void {
    return this.emitter.observe(observer);
  }

  /**
   * Unregisters an observer from the engine's event pipeline.
   *
   * @param observer - The observer to remove.
   */
  override unObserve(observer: GraphExecutionObserver): void {
    this.emitter.unObserve(observer);
  }

  /**
   * Dispatches an event to all registered observers.
   *
   * @param event - The event to distribute.
   */
  async dispatchEvent(event: GraphExecutionEvent): Promise<void> {
    await this.emitter.updateObservers(event);
  }

  /**
   * Executes a canonical workflow document with the given inputs and options.
   *
   * Resolution happens internally (DECAF-50 §4.9): the document is validated
   * through the nine-stage gate and resolved against the backend catalogue
   * before planning. Decorated `GraphWorkflowDefinition` objects are NOT
   * accepted — compile them with the §4.18 transition compiler first.
   *
   * @param document - The canonical workflow document to execute.
   * @param inputs - Workflow input values keyed by input port id.
   * @param options - Optional execution overrides (merged over the defaults).
   * @returns The complete execution result, including a `runId`, per-node
   *   results, and workflow outputs (or the failure payload).
   * @throws {GraphDocumentValidationError} when the document fails the
   *   nine-stage validation gate (carries every structured issue).
   */
  async execute(
    document: GraphWorkflowDocument,
    inputs: GraphExecutionValues = {},
    options: GraphExecutionOptions = {},
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphExecutionResult> {
    const { log, ctx } = (await this.logCtx(args, "execute", true)).for(this.execute);
    log.debug(`Executing workflow '${document.id || document.name}'`);
    const opts = this.mergeOptions(options);
    this.assertNotAborted(opts);
    // Resolve the authenticated principal from the run context (bound by the host
    // AuthHandler) and/or the explicit option, and bind its app parameters onto
    // the run metadata so `ctx.logger` carries them for the whole run.
    const auth = mergeGraphAuthData(graphAuthDataOf(ctx), opts.auth);
    opts.auth = auth;
    opts.metadata = { ...(opts.metadata ?? {}), ...auth };
    const runId = opts.runId ?? this.generateRunId();
    const path = opts.path ?? [];
    const eventFactory = new GraphExecutionEventFactory();
    const valueStore = createGraphValueRepository(this.valueAdapter);
    valueStore.seedWorkflowInputs(
      this.withWorkflowInputDefaults(document, inputs)
    );

    const emitFn = async (partial: Partial<GraphExecutionEvent>) => {
      await this.emitEvent(frame, {
        type: partial.type ?? GraphExecutionEventType.NODE_OUTPUT,
        runId,
        parentRunId: opts.parentRunId,
        workflowId: document.id || document.name,
        nodeId: partial.nodeId,
        path: partial.path ?? path,
        ...partial,
      });
    };
    const emitValidationEvent = async (
      partial: Partial<GraphExecutionEvent> & {
        type: GraphExecutionEventType;
      }
    ): Promise<void> => {
      const event = eventFactory.create({
        id: "",
        sequence: 0,
        timestamp: new Date(),
        runId,
        parentRunId: opts.parentRunId,
        workflowId: document.id || document.name,
        path,
        ...partial,
      } as Omit<GraphExecutionEvent, "id" | "sequence" | "timestamp">);
      await this.emitter.updateObservers(event);
    };

    // ------------------------------------------------------------------
    // Validation + resolution (nine-stage gate, §4.8) — internal.
    // ------------------------------------------------------------------
    await emitValidationEvent({
      type: GraphExecutionEventType.VALIDATION_STARTED,
      status: GraphExecutionStatus.PLANNING,
    });

    const validation = await this.documentValidator.validate(document, 0, ctx);

    if (!validation.valid || !validation.resolved) {
      await emitValidationEvent({
        type: GraphExecutionEventType.VALIDATION_FAILED,
        status: GraphExecutionStatus.FAILED,
        payload: { issues: validation.issues },
      });
      throw new GraphDocumentValidationError(
        `Graph workflow document '${document.id}' failed validation with ${validation.issues.length} issue(s)`,
        validation.issues
      );
    }

    await emitValidationEvent({
      type: GraphExecutionEventType.VALIDATION_COMPLETED,
      status: GraphExecutionStatus.PLANNING,
      payload: { issues: validation.issues.length },
    });

    this.assertNotAborted(opts);

    const plan = await this.planner.plan(validation.resolved);

    // Authorize the full workflow AND every planned node against the
    // authenticated principal before any node executes. A workflow/node that
    // declares namespaces fails closed when the principal holds none of them.
    this.client.authValidator.validate(document, plan, auth, log);
    log.debug(
      `Authorized workflow '${document.id || document.name}' for user ${
        auth.user ?? "anonymous"
      }`
    );

    const frame = new GraphExecutionFrame(
      runId,
      plan,
      valueStore,
      eventFactory
    );

    await this.emitEvent(frame, {
      type: GraphExecutionEventType.WORKFLOW_STARTED,
      runId,
      parentRunId: opts.parentRunId,
      workflowId: plan.workflowId,
      path,
      status: GraphExecutionStatus.RUNNING,
      payload: { inputs },
    });

    await this.emitEvent(frame, {
      type: GraphExecutionEventType.WORKFLOW_PLANNED,
      runId,
      parentRunId: opts.parentRunId,
      workflowId: plan.workflowId,
      path,
      status: GraphExecutionStatus.PLANNING,
      payload: { layers: plan.layers.length, nodes: plan.nodes.length },
    });

    try {
      for (const layer of plan.layers) {
        this.assertNotAborted(opts);
        await this.executeLayer(frame, plan, layer.nodes, opts, emitFn);
      }
      this.assertNotAborted(opts);

      const firstFailure = [...frame.nodeResults.values()].find(
        (result) => result.status === GraphExecutionStatus.FAILED
      );
      if (firstFailure?.error) {
        throw new GraphExecutionError(
          firstFailure.error.message,
          firstFailure.error.code ?? "GRAPH_EXECUTION_ERROR",
          firstFailure.error.details
        );
      }

      frame.finish();

      await this.emitEvent(frame, {
        type: GraphExecutionEventType.WORKFLOW_COMPLETED,
        runId,
        parentRunId: opts.parentRunId,
        workflowId: plan.workflowId,
        path,
        status: GraphExecutionStatus.SUCCEEDED,
        payload: { outputs: valueStore.getWorkflowValues() },
      });

      return buildGraphExecutionResult(
        frame,
        document,
        inputs,
        GraphExecutionStatus.SUCCEEDED,
        opts.metadata
      );
    } catch (error) {
      // A cooperative `GraphBreakSignal` is loop-control flow, not a workflow
      // failure: propagate it unchanged so the enclosing loop executor can stop
      // iterating instead of seeing a failed child run.
      if (error instanceof GraphBreakSignal) {
        frame.finish();
        throw error;
      }
      frame.finish();
      const errorPayload = this.toErrorPayload(error);

      if (
        error instanceof GraphRunCancelledError ||
        opts.abortSignal?.aborted === true
      ) {
        await this.emitEvent(frame, {
          type: GraphExecutionEventType.WORKFLOW_CANCELLED,
          runId,
          parentRunId: opts.parentRunId,
          workflowId: plan.workflowId,
          path,
          status: GraphExecutionStatus.CANCELLED,
          error: errorPayload,
        });

        return buildGraphExecutionResult(
          frame,
          document,
          inputs,
          GraphExecutionStatus.CANCELLED,
          opts.metadata
        );
      }

      await this.emitEvent(frame, {
        type: GraphExecutionEventType.WORKFLOW_FAILED,
        runId,
        parentRunId: opts.parentRunId,
        workflowId: plan.workflowId,
        path,
        status: GraphExecutionStatus.FAILED,
        error: errorPayload,
      });

      return buildGraphExecutionResult(
        frame,
        document,
        inputs,
        GraphExecutionStatus.FAILED,
        opts.metadata
      );
    }
  }

  /**
   * Pins a node and its upstream dependencies after a completed run.
   *
   * Delegates to {@link GraphPinningService}. The plan and result must come
   * from a prior successful execution of the same workflow.
   */
  async pinNode(options: GraphPinNodeOptions): Promise<void> {
    const service = this.createPinningService();
    await service.pinNode(options);
    await this.emitPinningEvent(options.nodeId, GraphExecutionEventType.NODE_PINNED);
  }

  /**
   * Unpins a node by its fingerprint.
   */
  async unpinNode(options: GraphUnpinNodeOptions): Promise<void> {
    const service = this.createPinningService();
    await service.unpinNode(options);
    await this.emitPinningEvent(options.nodeId, GraphExecutionEventType.NODE_UNPINNED);
  }

  /**
   * Creates a {@link GraphPinningService} backed by this engine's value store
   * adapter.
   */
  private createPinningService(): GraphPinningService {
    const store = createGraphValueRepository(this.valueAdapter);
    return new GraphPinningService(
      store,
      new GraphPinningPolicy(),
      new GraphPinningDependencyResolver()
    );
  }

  /**
   * Emits a pinning-related event to all observers.
   */
  private async emitPinningEvent(
    nodeId: string,
    type: GraphExecutionEventType
  ): Promise<void> {
    const factory = new GraphExecutionEventFactory();
    const event = factory.create({
      id: "",
      sequence: 0,
      timestamp: new Date(),
      runId: "pinning",
      workflowId: "",
      type,
      nodeId,
      path: [],
    } as Omit<GraphExecutionEvent, "id" | "sequence" | "timestamp">);
    await this.emitter.updateObservers(event);
  }

  /**
   * Fills unprovided workflow inputs with their declared port defaults.
   */
  private withWorkflowInputDefaults(
    document: GraphWorkflowDocument,
    inputs: GraphExecutionValues
  ): GraphExecutionValues {
    const seeded = { ...inputs };
    for (const port of document.inputs as GraphWorkflowPortInstance[]) {
      if (
        seeded[port.id] === undefined &&
        port.defaultValue !== undefined
      ) {
        seeded[port.id] = port.defaultValue;
      }
    }
    return seeded;
  }

  /**
   * Executes a layer of nodes with the configured concurrency.
   */
  private async executeLayer(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    nodes: GraphExecutionPlanNode[],
    opts: GraphExecutionOptions,
    emitFn: (event: Partial<GraphExecutionEvent>) => Promise<void>
  ): Promise<void> {
    const concurrency = Math.max(
      1,
      opts.concurrency ?? GRAPH_DEFAULT_CONCURRENCY
    );
    const queue = [...nodes];

    while (queue.length > 0) {
      const batch = queue.splice(0, concurrency);
      await Promise.all(
        batch.map((node) => this.executeNode(frame, plan, node, opts, emitFn))
      );
    }
  }

  /**
   * Executes a single node, honouring disabled-node semantics (§4.9).
   */
  private async executeNode(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    opts: GraphExecutionOptions,
    emitFn: (event: Partial<GraphExecutionEvent>) => Promise<void>
  ): Promise<void> {
    this.assertNotAborted(opts);
    if (!this.isNodeActivated(frame, plan, planNode)) {
      await this.skipInactiveNode(frame, plan, planNode, opts);
      return;
    }
    if (planNode.instance.disabled === true) {
      await this.executeDisabledNode(frame, plan, planNode, opts);
      return;
    }

    const startedAt = new Date();
    const nodePath = [...(opts.path ?? []), planNode.id];

    await this.emitEvent(frame, {
      type: GraphExecutionEventType.NODE_STARTED,
      runId: frame.runId,
      workflowId: plan.workflowId,
      nodeId: planNode.id,
      path: nodePath,
      status: GraphExecutionStatus.RUNNING,
    });
    this.emitNodeStateChanged(
      frame,
      plan,
      planNode,
      nodePath,
      GraphVisualState.RUNNING,
      GraphExecutionStatus.RUNNING
    );

    const inputs = await this.resolveNodeInputs(frame, plan, planNode, opts);

    // Cache-hit: check for a pinned value before executing the node
    if (opts.usePinnedValues) {
      const cached = await this.tryPinnedValue(frame, plan, planNode, inputs);
      if (cached) {
        frame.valueStore.setNodeOutputs(planNode.id, cached.outputs);
        this.routeOutgoingEdges(frame, plan, planNode, cached.outputs);

        const finishedAt = new Date();
        const result: GraphNodeExecutionResult = {
          nodeId: planNode.id,
          status: GraphExecutionStatus.CACHED,
          inputs,
          outputs: cached.outputs,
          startedAt,
          finishedAt,
          fromCache: true,
          pinned: true,
          events: [],
        };
        frame.recordNodeResult(result);

        await this.emitEvent(frame, {
          type: GraphExecutionEventType.NODE_CACHE_HIT,
          runId: frame.runId,
          workflowId: plan.workflowId,
          nodeId: planNode.id,
          path: nodePath,
          status: GraphExecutionStatus.CACHED,
          payload: { outputs: cached.outputs },
        });

        await this.emitEvent(frame, {
          type: GraphExecutionEventType.NODE_COMPLETED,
          runId: frame.runId,
          workflowId: plan.workflowId,
          nodeId: planNode.id,
          path: nodePath,
          status: GraphExecutionStatus.SUCCEEDED,
          payload: { outputs: cached.outputs, fromCache: true },
        });
        this.emitNodeStateChanged(
          frame,
          plan,
          planNode,
          nodePath,
          GraphVisualState.SUCCEEDED,
          GraphExecutionStatus.SUCCEEDED
        );
        return;
      }
    }

    try {
      const context = new GraphExecutionContext(
        frame.runId,
        opts.parentRunId,
        plan.workflowId,
        plan.resolved.document,
        planNode.instance,
        planNode.manifest,
        nodePath,
        emitFn,
        opts.metadata,
        this,
        opts.abortSignal,
        this.executionLimits(opts)
      );

      const parameters = await this.resolveNodeParameters(
        planNode,
        inputs,
        opts
      );

      const request: GraphNodeExecutionRequest = {
        nodeId: planNode.id,
        kind: planNode.kind,
        inputs,
        parameters,
        credentials: this.collectCredentials(planNode),
        metadata: planNode.instance.metadata,
      };

      const rawOutputs = await this.invokeExecutor(planNode, request, context);
      const outputs = this.validateNodeOutputs(planNode, rawOutputs ?? {});

      frame.valueStore.setNodeOutputs(planNode.id, outputs);
      this.routeOutgoingEdges(frame, plan, planNode, outputs);

      const finishedAt = new Date();
      const result: GraphNodeExecutionResult = {
        nodeId: planNode.id,
        status: GraphExecutionStatus.SUCCEEDED,
        inputs,
        outputs,
        startedAt,
        finishedAt,
        events: [],
      };
      frame.recordNodeResult(result);

      await this.emitEvent(frame, {
        type: GraphExecutionEventType.NODE_COMPLETED,
        runId: frame.runId,
        workflowId: plan.workflowId,
        nodeId: planNode.id,
        path: nodePath,
        status: GraphExecutionStatus.SUCCEEDED,
        payload: { outputs },
      });
      this.emitNodeStateChanged(
        frame,
        plan,
        planNode,
        nodePath,
        GraphVisualState.SUCCEEDED,
        GraphExecutionStatus.SUCCEEDED
      );
    } catch (error) {
      // Loop-control flow is not a node failure: rethrow the break token so
      // the enclosing loop executor observes it rather than a FAILED node.
      if (error instanceof GraphBreakSignal) throw error;
      const finishedAt = new Date();
      const errorPayload = this.toErrorPayload(error);
      const result: GraphNodeExecutionResult = {
        nodeId: planNode.id,
        status: GraphExecutionStatus.FAILED,
        inputs,
        error: errorPayload,
        startedAt,
        finishedAt,
        events: [],
      };
      frame.recordNodeResult(result);

      await this.emitEvent(frame, {
        type: GraphExecutionEventType.NODE_FAILED,
        runId: frame.runId,
        workflowId: plan.workflowId,
        nodeId: planNode.id,
        path: nodePath,
        status: GraphExecutionStatus.FAILED,
        error: errorPayload,
      });
      this.emitNodeStateChanged(
        frame,
        plan,
        planNode,
        nodePath,
        GraphVisualState.FAILED,
        GraphExecutionStatus.FAILED
      );

      if (opts.failFast ?? true) throw error;
    }
  }

  /**
   * Resolves whether a plan node is activated for execution under the
   * DECAF-50 §4.9 branch semantics. A node with no incoming data edges is
   * a root/source node and always runs. A node fed by one or more data
   * edges runs only when at least one of those edges was activated by a
   * routed upstream output port — a branch the upstream switch (or any
   * partial-output node) did not select leaves its downstream edges
   * unactivated, so the branch is never executed. Workflow-boundary edges
   * are active from the start because workflow inputs are seeded before
   * execution begins.
   */
  private isNodeActivated(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode
  ): boolean {
    const incoming = (plan.incomingByNode.get(planNode.id) ?? []).filter(
      (edge) => edge.type === "data"
    );
    if (incoming.length === 0) return true;
    return incoming.some(
      (edge) =>
        edge.sourceNodeId === GRAPH_WORKFLOW_BOUNDARY ||
        frame.isDataEdgeActive(edge.id)
    );
  }

  /**
   * Skips a node whose incoming data edges were all left unactivated by an
   * upstream branch selection. The node is not executed and its outputs are
   * never routed or collected into workflow outputs (DECAF-50 §4.9).
   */
  private async skipInactiveNode(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    opts: GraphExecutionOptions
  ): Promise<void> {
    const startedAt = new Date();
    const nodePath = [...(opts.path ?? []), planNode.id];

    await this.emitEvent(frame, {
      type: GraphExecutionEventType.NODE_SKIPPED,
      runId: frame.runId,
      workflowId: plan.workflowId,
      nodeId: planNode.id,
      path: nodePath,
      status: GraphExecutionStatus.SKIPPED,
      payload: { reason: "branchNotSelected" },
    });

    const result: GraphNodeExecutionResult = {
      nodeId: planNode.id,
      status: GraphExecutionStatus.SKIPPED,
      inputs: {},
      startedAt,
      finishedAt: new Date(),
      events: [],
    };
    frame.recordNodeResult(result);
    this.emitNodeStateChanged(
      frame,
      plan,
      planNode,
      nodePath,
      GraphVisualState.SKIPPED,
      GraphExecutionStatus.SKIPPED
    );
  }

  /**
   * Applies the explicit disabled-node semantics (§4.9):
   * `skip`, `passThroughFirstInput`, or `emitDefaults`, resolved from the
   * instance metadata, document settings, and the default.
   */
  private async executeDisabledNode(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    opts: GraphExecutionOptions
  ): Promise<void> {
    const startedAt = new Date();
    const nodePath = [...(opts.path ?? []), planNode.id];
    const behavior = GraphParameterValidator.disabledBehaviorOf(
      planNode.instance,
      plan.resolved.document.settings
    );

    await this.emitEvent(frame, {
      type: GraphExecutionEventType.NODE_SKIPPED,
      runId: frame.runId,
      workflowId: plan.workflowId,
      nodeId: planNode.id,
      path: nodePath,
      status: GraphExecutionStatus.SKIPPED,
      payload: { disabled: true, behavior },
    });

    if (behavior === "skip") {
      const result: GraphNodeExecutionResult = {
        nodeId: planNode.id,
        status: GraphExecutionStatus.SKIPPED,
        inputs: {},
        startedAt,
        finishedAt: new Date(),
        events: [],
      };
      frame.recordNodeResult(result);
      this.emitNodeStateChanged(
        frame,
        plan,
        planNode,
        nodePath,
        GraphVisualState.SKIPPED,
        GraphExecutionStatus.SKIPPED
      );
      return;
    }

    const inputs = await this.resolveNodeInputs(frame, plan, planNode, opts);
    let outputs: GraphExecutionValues;

    if (behavior === "passThroughFirstInput") {
      const firstIncoming = (plan.incomingByNode.get(planNode.id) ?? []).find(
        (edge) => edge.type === "data"
      );
      const firstOutput = planNode.manifest.outputs[0]?.id ?? "value";
      const value = firstIncoming
        ? frame.valueStore.getPort(
            firstIncoming.sourceNodeId,
            firstIncoming.sourcePort
          )
        : Object.values(inputs)[0];
      outputs = { [firstOutput]: value };
    } else {
      // emitDefaults — every declared output port is emitted with its
      // declared default (absent a declared default, undefined).
      outputs = {};
      for (const port of planNode.manifest.outputs) {
        outputs[port.id] = port.metadata?.["defaultValue"];
      }
    }

    frame.valueStore.setNodeOutputs(planNode.id, outputs);
    this.routeOutgoingEdges(frame, plan, planNode, outputs);

    const result: GraphNodeExecutionResult = {
      nodeId: planNode.id,
      status: GraphExecutionStatus.SUCCEEDED,
      inputs,
      outputs,
      startedAt,
      finishedAt: new Date(),
      events: [],
    };
    frame.recordNodeResult(result);
    this.emitNodeStateChanged(
      frame,
      plan,
      planNode,
      nodePath,
      GraphVisualState.SUCCEEDED,
      GraphExecutionStatus.SUCCEEDED
    );
  }

  /**
   * Invokes the node's catalogue-resolved executor (§4.9 request contract,
   * post-cutover: every executor receives the full request with
   * configuration and input data separated).
   */
  private async invokeExecutor(
    planNode: GraphExecutionPlanNode,
    request: GraphNodeExecutionRequest,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    return await planNode.executor.execute(request, context);
  }

  /**
   * Validates executor outputs against the effective output manifest
   * (§4.9): unknown outputs are rejected by default; missing required
   * outputs fail the node. Lenient transition manifests (legacy
   * executor-only registrations) are exempt until cutover.
   */
  private validateNodeOutputs(
    planNode: GraphExecutionPlanNode,
    outputs: GraphExecutionValues
  ): GraphExecutionValues {
    const manifest = planNode.manifest;
    if (manifest.policies?.allowUnknownOutputs === true) {
      return outputs;
    }

    const declaredOutputs = new Set(
      manifest.outputs.map((port) => port.id)
    );
    const unknownOutputs = Object.keys(outputs).filter(
      (key) => !declaredOutputs.has(key)
    );
    if (unknownOutputs.length > 0) {
      throw new GraphExecutionError(
        `Node '${planNode.id}' of kind '${planNode.kind}' produced unknown output(s): ${unknownOutputs.join(", ")}`,
        "GRAPH_OUTPUT_VALIDATION_FAILED",
        { nodeId: planNode.id, unknownOutputs }
      );
    }

    const missingRequired = manifest.outputs
      .filter((port) => port.required === true && !(port.id in outputs))
      .map((port) => port.id);
    if (missingRequired.length > 0) {
      throw new GraphExecutionError(
        `Node '${planNode.id}' of kind '${planNode.kind}' did not produce required output(s): ${missingRequired.join(", ")}`,
        "GRAPH_OUTPUT_VALIDATION_FAILED",
        { nodeId: planNode.id, missingRequired }
      );
    }

    return outputs;
  }

  /**
   * Collects the resolved credential references for a node: credential-type
   * parameter values plus the `credentials` record in instance metadata.
   * Documents carry references only — secret material never enters requests.
   */
  private collectCredentials(planNode: GraphExecutionPlanNode): GraphResolvedCredentials {
    const credentials: GraphResolvedCredentials = {};
    for (const parameter of planNode.manifest.parameters) {
      if (parameter.type !== "credential") continue;
      const value: unknown = (planNode.instance.parameters ?? {})[parameter.id];
      if (typeof value === "string" && value.length > 0) {
        credentials[parameter.id] = {
          credentialId: value,
          credentialType: parameter.credentialType ?? "",
        };
      } else if (isGraphCredentialReferenceLike(value)) {
        credentials[parameter.id] = {
          credentialId: value.credentialId,
          credentialType: value.credentialType,
        };
      }
    }
    const extra = (planNode.instance.metadata ?? {})["credentials"];
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      for (const [key, raw] of Object.entries(
        extra as Record<string, GraphJsonValue>
      )) {
        const value: unknown = raw;
        if (typeof value === "string" && value.length > 0) {
          credentials[key] = { credentialId: value, credentialType: "" };
        } else if (isGraphCredentialReferenceLike(value)) {
          credentials[key] = {
            credentialId: value.credentialId,
            credentialType: value.credentialType,
          };
        }
      }
    }
    return credentials;
  }

  /**
   * Resolves a node's input values from routed data edges, literal bindings,
   * allowed expression bindings, and manifest port defaults (§4.9).
   *
   * When multiple edges target the same port, their values are spread into the
   * top-level inputs keyed by each edge's `sourcePort`. This allows multiple
   * workflow input badges to connect to a single port (e.g. the Code node's
   * `data` port) and have all values accessible directly as
   * `$input.{sourcePort}` (e.g. `$input.count`, `$input.text`).
   */
  private async resolveNodeInputs(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    opts: GraphExecutionOptions
  ): Promise<GraphExecutionValues> {
    const inputs: GraphExecutionValues = {};
    const incoming = (plan.incomingByNode.get(planNode.id) ?? []).filter(
      (edge) => edge.type === "data"
    );

    const edgesByTarget = new Map<string, typeof incoming>();
    for (const edge of incoming) {
      const list = edgesByTarget.get(edge.targetPort) ?? [];
      list.push(edge);
      edgesByTarget.set(edge.targetPort, list);
    }

    for (const [targetPort, edges] of edgesByTarget) {
      if (edges.length === 1) {
        inputs[targetPort] = frame.valueStore.getPort(
          edges[0].sourceNodeId,
          edges[0].sourcePort
        );
      } else {
        for (const edge of edges) {
          inputs[edge.sourcePort] = frame.valueStore.getPort(
            edge.sourceNodeId,
            edge.sourcePort
          );
        }
      }
    }

    // Literal bindings, expression bindings, and manifest defaults.
    const bindings = planNode.instance.inputBindings ?? {};
    for (const port of planNode.manifest.inputs) {
      const binding: GraphInputBinding | undefined = bindings[port.id];
      if (binding?.mode === "literal") {
        inputs[port.id] = binding.value;
      } else if (binding?.mode === "expression") {
        inputs[port.id] = await this.evaluateExpressionBinding(
          planNode,
          binding.expression,
          inputs,
          opts
        );
      } else if (inputs[port.id] === undefined) {
        const defaultValue = port.metadata?.["defaultValue"];
        if (defaultValue !== undefined) {
          inputs[port.id] = defaultValue;
        }
      }
    }

    return inputs;
  }

  /**
   * Resolves a node's persisted parameters at execution time, evaluating any
   * `GraphValueTemplate` user property through the code-evaluator VM and
   * leaving straight literal values unchanged.
   */
  private async resolveNodeParameters(
    planNode: GraphExecutionPlanNode,
    inputs: GraphExecutionValues,
    opts: GraphExecutionOptions
  ): Promise<Record<string, GraphJsonValue>> {
    const parameters = planNode.instance.parameters ?? {};
    const resolved: Record<string, GraphJsonValue> = {};
    for (const [key, value] of Object.entries(parameters)) {
      resolved[key] = isGraphValueTemplate(value)
        ? await this.evaluateValueTemplate(value, planNode, inputs, opts)
        : value;
    }
    return resolved;
  }

  /**
   * Evaluates a persisted `GraphValueTemplate` with the pluggable
   * {@link CodeSandboxEvaluator} (DECAF-32 §22.4) — no new evaluator.
   * `expression` mode evaluates the body directly; `template` mode compiles its
   * `{{ ... }}` placeholders into a JavaScript template literal evaluated in
   * the same sandbox, so both modes share the code-evaluator VM.
   */
  private async evaluateValueTemplate(
    template: GraphValueTemplate,
    planNode: GraphExecutionPlanNode,
    inputs: GraphExecutionValues,
    opts: GraphExecutionOptions
  ): Promise<GraphJsonValue> {
    const evaluator = this.codeSandboxEvaluator;
    if (!evaluator) {
      throw new GraphExecutionError(
        `Value template on node '${planNode.id}' requires a CodeSandboxEvaluator to be registered in GraphExecutionEngineConfig.codeSandboxEvaluator`,
        "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
        { nodeId: planNode.id }
      );
    }
    const language =
      template.language ?? graphValueTemplateDefaultLanguage(template.mode);
    const code =
      template.mode === "template"
        ? graphTemplateToExpression(template.expression)
        : template.expression;
    const md = opts.metadata as Record<string, unknown> | undefined;
    const result = await evaluator.evaluate({
      code,
      language: language === "typescript" ? "typescript" : "javascript",
      input: inputs,
      vars: (md?.vars as Record<string, unknown> | undefined) ?? undefined,
      item: md?.item,
      index: md?.index as number | undefined,
      abortSignal: opts.abortSignal,
    });
    return result as GraphJsonValue;
  }

  /**
   * Evaluates an expression binding with the EXISTING allowed-expression
   * machinery only (the pluggable {@link CodeSandboxEvaluator}, DECAF-32
   * §22.4) — no new evaluator. The expression sees the already-routed input
   * values as `$input` and the run metadata as context.
   */
  private async evaluateExpressionBinding(
    planNode: GraphExecutionPlanNode,
    expression: string,
    inputs: GraphExecutionValues,
    opts: GraphExecutionOptions
  ): Promise<unknown> {
    const evaluator = this.codeSandboxEvaluator;
    if (!evaluator) {
      throw new GraphExecutionError(
        `Expression binding on node '${planNode.id}' requires a CodeSandboxEvaluator to be registered in GraphExecutionEngineConfig.codeSandboxEvaluator`,
        "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
        { nodeId: planNode.id, expression }
      );
    }
    const md = opts.metadata as Record<string, unknown> | undefined;
    return await evaluator.evaluate({
      code: expression,
      language: "javascript",
      input: inputs,
      vars: (md?.vars as Record<string, unknown> | undefined) ?? undefined,
      item: md?.item,
      index: md?.index as number | undefined,
      abortSignal: opts.abortSignal,
    });
  }

  /**
   * Attempts to read a pinned value for the node. Returns the cached outputs
   * when a valid pinned value exists, or `undefined` to proceed with normal
   * execution.
   */
  private async tryPinnedValue(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    inputs: GraphExecutionValues
  ): Promise<GraphCachedValue | undefined> {
    const policy = new GraphPinningPolicy();
    if (!policy.shouldUsePinnedValue(planNode)) return undefined;

    const service = this.createPinningService();
    const depFingerprints = this.computeDependencyFingerprints(frame, plan, planNode.id);
    return service.readPinnedValue(
      plan.workflowId,
      planNode,
      inputs,
      depFingerprints
    );
  }

  /**
   * Recursively computes fingerprints for all upstream dependencies of a node
   * using the results already accumulated in the frame.
   */
  private computeDependencyFingerprints(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    nodeId: string
  ): Record<string, string> {
    const service = this.createPinningService();
    const depResolver = new GraphPinningDependencyResolver();
    const deps = depResolver.getDependencies(plan, nodeId);
    const fingerprints: Record<string, string> = {};
    for (const dep of deps) {
      const node = plan.nodes.find((n) => n.id === dep);
      if (node) {
        const depResult = frame.nodeResults.get(dep);
        const inputs = depResult?.inputs ?? {};
        const nestedDeps = this.computeDependencyFingerprints(frame, plan, dep);
        fingerprints[dep] = service.computeFingerprint(
          plan.workflowId,
          node,
          inputs,
          nestedDeps
        );
      }
    }
    return fingerprints;
  }

  /**
   * Routes a node's outputs to downstream inputs and workflow outputs along
   * data edges (connection edges are structural and never route values).
   *
   * An edge is traversed only when the source node actually emitted the
   * edge's `sourcePort` (DECAF-50 §4.9 branch semantics). A node that
   * emitted a subset of its declared outputs — e.g. a switch that selected
   * one case — therefore activates only the downstream branch edges of the
   * emitted ports; unselected branch edges are left unactivated, so their
   * downstream nodes are skipped and never contribute to workflow outputs.
   * Emitting an output port explicitly with `undefined` still counts as
   * activated (the port was produced by the executor).
   */
  private routeOutgoingEdges(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    outputs: GraphExecutionValues
  ): void {
    const outgoing = (plan.outgoingByNode.get(planNode.id) ?? []).filter(
      (edge) => edge.type === "data"
    );
    for (const edge of outgoing) {
      if (!Object.prototype.hasOwnProperty.call(outputs, edge.sourcePort)) {
        // The source node did not emit this output port: the edge's branch
        // was not selected, so no value is routed.
        continue;
      }
      const value = outputs[edge.sourcePort];
      frame.activateDataEdge(edge.id);
      if (edge.targetNodeId === GRAPH_WORKFLOW_BOUNDARY) {
        frame.valueStore.setWorkflowOutput(edge.targetPort, value);
      }
      this.emitEdgeStateChanged(
        frame,
        plan,
        planNode,
        edge,
        GraphVisualState.SUCCEEDED,
        GraphExecutionStatus.SUCCEEDED
      );
      this.emitEvent(frame, {
        type: GraphExecutionEventType.EDGE_VALUE_ROUTED,
        runId: frame.runId,
        workflowId: plan.workflowId,
        edgeId: edge.id,
        nodeId: planNode.id,
        path: [],
        payload: { edge, value },
      }).catch(() => {
        // observer failures must not crash
      });
    }
  }

  /**
   * Emits an event, records it in the frame, and dispatches to observers.
   */
  private async emitEvent(
    frame: GraphExecutionFrame,
    partial: Partial<GraphExecutionEvent> & {
      type: GraphExecutionEventType;
      runId: GraphRunId;
      workflowId: string;
      path: string[];
    }
  ): Promise<void> {
    const event = frame.eventFactory.create({
      id: "",
      sequence: 0,
      timestamp: new Date(),
      ...partial,
    } as Omit<GraphExecutionEvent, "id" | "sequence" | "timestamp">);
    frame.appendEvent(event);
    await this.emitter.updateObservers(event);
  }

  /**
   * Emits a `NODE_STATE_CHANGED` event (DECAF-48 §4.4) carrying the given
   * visual state for the node. Rides the existing Observable pipeline; no
   * second out-of-band channel.
   */
  private emitNodeStateChanged(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    nodePath: string[],
    state: GraphVisualState,
    status?: GraphExecutionStatus
  ): void {
    this.emitEvent(frame, {
      type: GraphExecutionEventType.NODE_STATE_CHANGED,
      runId: frame.runId,
      workflowId: plan.workflowId,
      nodeId: planNode.id,
      path: nodePath,
      status,
      payload: {
        nodeId: planNode.id,
        state,
        runId: frame.runId,
        workflowId: plan.workflowId,
        status,
      },
    }).catch(() => {
      // observer failures must not crash execution
    });
  }

  /**
   * Emits an `EDGE_STATE_CHANGED` event (DECAF-48 §4.4) carrying the given
   * visual state for a routed edge.
   */
  private emitEdgeStateChanged(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    edge: GraphExecutionPlanEdge,
    state: GraphVisualState,
    status?: GraphExecutionStatus
  ): void {
    this.emitEvent(frame, {
      type: GraphExecutionEventType.EDGE_STATE_CHANGED,
      runId: frame.runId,
      workflowId: plan.workflowId,
      edgeId: edge.id,
      nodeId: planNode.id,
      path: [],
      status,
      payload: {
        edgeId: edge.id,
        state,
        runId: frame.runId,
        workflowId: plan.workflowId,
        nodeId: planNode.id,
        status,
      },
    }).catch(() => {
      // observer failures must not crash execution
    });
  }

  /**
   * Merges default options with the given options.
   */
  private mergeOptions(
    options: GraphExecutionOptions
  ): GraphExecutionOptions {
    return {
      concurrency: GRAPH_DEFAULT_CONCURRENCY,
      failFast: true,
      validateInputs: true,
      validateOutputs: true,
      maxLoopIterations: GRAPH_MAX_LOOP_ITERATIONS,
      maxForeachIterations: GRAPH_MAX_FOREACH_ITERATIONS,
      usePinnedValues: true,
      writeThroughCache: false,
      path: [],
      metadata: {},
      ...this.defaultOptions,
      ...options,
    };
  }

  /**
   * Resolves the effective loop-iteration ceilings for a run. A node-level
   * `maxIterations` can never exceed these; loop executors read them from the
   * node context.
   */
  private executionLimits(opts: GraphExecutionOptions): GraphExecutionLimits {
    return {
      maxLoopIterations: opts.maxLoopIterations ?? GRAPH_MAX_LOOP_ITERATIONS,
      maxForeachIterations:
        opts.maxForeachIterations ?? GRAPH_MAX_FOREACH_ITERATIONS,
    };
  }

  private assertNotAborted(opts: GraphExecutionOptions): void {
    if (opts.abortSignal?.aborted === true) {
      throw new GraphRunCancelledError(opts.runId ?? "unknown");
    }
  }

  /**
   * Generates a cryptographically random run id. `crypto.randomUUID` is always
   * available in the backend runtimes as-graph targets; the frontend never
   * creates run ids. If it is somehow unavailable the engine fails loudly
   * rather than falling back to a predictable, guessable id.
   *
   * @throws {GraphExecutionError} when `crypto.randomUUID` is unavailable.
   */
  private generateRunId(): string {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.randomUUID !== "function") {
      throw new GraphExecutionError(
        "Cannot generate a graph run id: crypto.randomUUID is unavailable in this runtime",
        "GRAPH_RUN_ID_ERROR",
        { runtime: typeof globalThis.crypto }
      );
    }
    return cryptoApi.randomUUID();
  }

  /**
   * Converts an error into a serialized payload.
   */
  private toErrorPayload(error: unknown): GraphExecutionErrorPayload {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code:
          (error as any).graphCode ??
          (typeof (error as any).code === "number"
            ? String((error as any).code)
            : (error as any).code),
      };
    }
    return { name: "UnknownError", message: String(error) };
  }
}
