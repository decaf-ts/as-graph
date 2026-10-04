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
  GraphExecutionEvent,
  GraphWorkflowDocument,
  GraphWorkflowPortInstance,
} from "../../shared/graph";

import {
  GRAPH_DEFAULT_CONCURRENCY,
  GRAPH_MAX_FOREACH_ITERATIONS,
  GRAPH_MAX_LOOP_ITERATIONS,
} from "../constants";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../shared/graph";
import { GraphExecutionError, GraphRunCancelledError } from "../errors";
import type {
  GraphExecutionOptions,
  GraphExecutionResult,
  GraphExecutionValues,
  GraphPinNodeOptions,
  GraphUnpinNodeOptions,
} from "../types";
import type { GraphExecutionObserver } from "../events/GraphExecutionObserver";
import { GraphExecutionEventEmitter } from "../events/GraphExecutionEventEmitter";
import { GraphExecutionEventFactory } from "../events/GraphExecutionEventFactory";
import type { GraphNodeExecutorRegistry } from "../registry/GraphNodeExecutorRegistry";
import type { GraphNodeCatalogue } from "../catalog/GraphNodeCatalogue";
import { GraphExecutionPlanner } from "../planning/GraphExecutionPlanner";
import {
  GraphWorkflowDocumentValidator,
  type GraphWorkflowDocumentValidationLimits,
} from "../validation/GraphWorkflowDocumentValidator";
import type { GraphCredentialAuthorizer } from "../validation/GraphCredentialReferenceValidator";
import { GraphDocumentValidationError } from "../validation/GraphValidationErrors";
import { createGraphValueRepository } from "../store/GraphValueRepository";
import { GraphPinningService } from "../pinning/GraphPinningService";
import { GraphPinningPolicy } from "../pinning/GraphPinningPolicy";
import { GraphPinningDependencyResolver } from "../pinning/GraphPinningDependencyResolver";
import { GraphExecutionFrame } from "./GraphExecutionFrame";
import type { CodeSandboxEvaluator } from "./CodeSandboxEvaluator";
import {
  GraphEngineEventSink,
  resolveGraphBackendCapabilities,
  type GraphBackendCapabilities,
  type GraphBackendWorkflowStore,
  type GraphBackendWorkflowSummary,
  type GraphExecutionBackend,
} from "./GraphExecutionBackend";
import { detectGraphCodeModeSurfaces } from "./GraphCodeMode";
import { GraphExecutionBackendRegistry } from "./GraphExecutionBackendRegistry";
import { LocalGraphExecutionBackend } from "./LocalGraphExecutionBackend";
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
   * Pluggable execution backend. Defaults to a fresh
   * {@link LocalGraphExecutionBackend} (the extracted reference interpreter);
   * remote/translated backends (Dagster, Mastra) are supplied here. The facade
   * still owns validation, resolution, auth, planning, event sequencing, and
   * observer dispatch for every backend.
   */
  backend?: GraphExecutionBackend;
  /**
   * Workflow catalogue port used by the default {@link LocalGraphExecutionBackend}
   * to back the engine-agnostic `listWorkflows`/`getWorkflow` seam. Hosts pass
   * their `GraphWorkflowService` here; remote backends surface their own
   * catalogue through the optional {@link GraphExecutionBackend} extension and
   * ignore this port.
   */
  workflowStore?: GraphBackendWorkflowStore;
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
  /** Pluggable execution backend (local by default). */
  backend: GraphExecutionBackend;
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
    const backend =
      config.backend ??
      GraphExecutionBackendRegistry.current ??
      new LocalGraphExecutionBackend();
    const client: GraphExecutionEngineClient = {
      registry: config.registry,
      catalogue,
      planner: config.planner ?? new GraphExecutionPlanner(),
      backend,
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
    await backend.initialize({
      valueAdapter,
      ...(config.codeSandboxEvaluator
        ? { codeSandboxEvaluator: config.codeSandboxEvaluator }
        : {}),
      ...(config.workflowStore
        ? { workflowStore: config.workflowStore }
        : {}),
      engine: this,
    });
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
    // Propagate the resolved run id onto the options so every backend
    // (including remote/translated backends that never see the local frame)
    // receives the authoritative run id.
    opts.runId = runId;
    const path = opts.path ?? [];
    const eventFactory = new GraphExecutionEventFactory();
    const valueStore = createGraphValueRepository(this.valueAdapter);
    valueStore.seedWorkflowInputs(
      this.withWorkflowInputDefaults(document, inputs)
    );

    const sink = new GraphEngineEventSink(this.emitter, eventFactory, {
      runId,
      parentRunId: opts.parentRunId,
      workflowId: document.id || document.name,
      path,
      engine: this,
      ...(this.codeSandboxEvaluator
        ? { codeSandboxEvaluator: this.codeSandboxEvaluator }
        : {}),
    });

    // ------------------------------------------------------------------
    // Validation + resolution (nine-stage gate, §4.8) — internal.
    // ------------------------------------------------------------------
    await sink.emit({
      type: GraphExecutionEventType.VALIDATION_STARTED,
      status: GraphExecutionStatus.PLANNING,
    });

    const validation = await this.documentValidator.validate(document, 0, ctx);

    if (!validation.valid || !validation.resolved) {
      await sink.emit({
        type: GraphExecutionEventType.VALIDATION_FAILED,
        status: GraphExecutionStatus.FAILED,
        payload: { issues: validation.issues },
      });
      throw new GraphDocumentValidationError(
        `Graph workflow document '${document.id}' failed validation with ${validation.issues.length} issue(s)`,
        validation.issues
      );
    }

    await sink.emit({
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

    // SAA-193 C1: fail closed before delegating a code-mode workflow to a
    // non-local backend. A remote/translated backend can only run code-mode
    // surfaces when it declares `codeMode: "hostSide"` AND the facade has a
    // configured sandbox evaluator; otherwise the run is rejected here, before
    // any remote launch.
    this.assertCodeModeSupported(document);

    const frame = new GraphExecutionFrame(
      runId,
      plan,
      valueStore,
      eventFactory
    );
    sink.bindFrame(frame);

    await sink.emit({
      type: GraphExecutionEventType.WORKFLOW_STARTED,
      runId,
      parentRunId: opts.parentRunId,
      workflowId: plan.workflowId,
      path,
      status: GraphExecutionStatus.RUNNING,
      payload: { inputs },
    });

    await sink.emit({
      type: GraphExecutionEventType.WORKFLOW_PLANNED,
      runId,
      parentRunId: opts.parentRunId,
      workflowId: plan.workflowId,
      path,
      status: GraphExecutionStatus.PLANNING,
      payload: { layers: plan.layers.length, nodes: plan.nodes.length },
    });

    return await this.client.backend.execute(
      { document, plan, inputs, options: opts, events: sink },
      ...args
    );
  }

  /**
   * The active pluggable execution backend. Exposed so the run lifecycle service
   * can delegate optional backend extensions (e.g. the SAA-196 resume extension)
   * without re-resolving the configured backend.
   */
  get backend(): GraphExecutionBackend {
    return this.client.backend;
  }

  /**
   * Effective capability metadata of the active backend. Hosts and servers read
   * this to surface what the current backend supports (code-mode handling and
   * workflow listing/lookup) without probing it, and an unsupported operation is
   * reported as `not_supported` rather than a silently empty result.
   */
  get backendCapabilities(): GraphBackendCapabilities {
    return resolveGraphBackendCapabilities(this.client.backend);
  }

  /**
   * Lists the workflows the active backend can surface, through the engine-agnostic
   * seam. Works identically for the default local backend (over its wired
   * workflow store) and any remote/translated backend that implements the
   * optional catalogue extension.
   *
   * @param args - Optional decaf contextual arguments forwarded to the backend.
   * @returns Workflow summaries.
   * @throws {GraphExecutionError} with `GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED`
   *   when the active backend declares no listing support.
   */
  async listWorkflows(
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphBackendWorkflowSummary[]> {
    const backend = this.client.backend;
    const capabilities = resolveGraphBackendCapabilities(backend);
    if (
      capabilities.workflows.list !== "supported" ||
      typeof backend.listWorkflows !== "function"
    ) {
      throw new GraphExecutionError(
        `Graph execution backend '${this.backendName}' does not support workflow listing`,
        "GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED",
        { backend: this.backendName }
      );
    }
    return await backend.listWorkflows(...args);
  }

  /**
   * Looks up a single canonical workflow document through the active backend's
   * engine-agnostic catalogue seam. The default local backend reads it from its
   * wired workflow store; remote backends surface their own catalogue.
   *
   * @param workflowId - The canonical workflow id to read.
   * @param args - Optional decaf contextual arguments forwarded to the backend.
   * @returns The canonical workflow document.
   * @throws {GraphExecutionError} with `GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED`
   *   when the active backend declares no lookup support.
   */
  async getWorkflow(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowDocument> {
    const backend = this.client.backend;
    const capabilities = resolveGraphBackendCapabilities(backend);
    if (
      capabilities.workflows.get !== "supported" ||
      typeof backend.getWorkflow !== "function"
    ) {
      throw new GraphExecutionError(
        `Graph execution backend '${this.backendName}' does not support workflow lookup`,
        "GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED",
        { backend: this.backendName, workflowId }
      );
    }
    return await backend.getWorkflow(workflowId, ...args);
  }

  /**
   * Lists the workflows a *specific* registered backend can surface, resolved by
   * flavour. This is the flavour-scoped counterpart of {@link listWorkflows}: the
   * server exposes the engine catalogue per engine id, and every registered backend
   * is reached through the same engine-agnostic {@link GraphExecutionBackend}
   * listing seam with the same fail-closed capability gate and error code.
   *
   * @param flavour - The registered backend flavour (allowlisted engine id).
   * @param args - Optional decaf contextual arguments forwarded to the backend.
   * @returns Workflow summaries.
   * @throws {GraphExecutionError} with `GRAPH_EXECUTION_BACKEND_NOT_REGISTERED`
   *   for an unknown flavour, or `GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED` when the
   *   backend declares no listing support.
   */
  async listEngineWorkflows(
    flavour: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphBackendWorkflowSummary[]> {
    const backend =
      GraphExecutionBackendRegistry.getOrFail<GraphExecutionBackend>(flavour);
    const capabilities = resolveGraphBackendCapabilities(backend);
    if (
      capabilities.workflows.list !== "supported" ||
      typeof backend.listWorkflows !== "function"
    ) {
      throw new GraphExecutionError(
        `Graph execution backend '${flavour}' does not support workflow listing`,
        "GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED",
        { backend: flavour }
      );
    }
    return await backend.listWorkflows(...args);
  }

  /**
   * Looks up a single canonical workflow document on a *specific* registered
   * backend, resolved by flavour. Flavour-scoped counterpart of
   * {@link getWorkflow} with the same capability gate and error code.
   *
   * @param flavour - The registered backend flavour (allowlisted engine id).
   * @param workflowId - The canonical workflow id to read.
   * @param args - Optional decaf contextual arguments forwarded to the backend.
   * @returns The canonical workflow document.
   * @throws {GraphExecutionError} with `GRAPH_EXECUTION_BACKEND_NOT_REGISTERED`
   *   for an unknown flavour, or `GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED` when the
   *   backend declares no lookup support.
   */
  async getEngineWorkflow(
    flavour: string,
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowDocument> {
    const backend =
      GraphExecutionBackendRegistry.getOrFail<GraphExecutionBackend>(flavour);
    const capabilities = resolveGraphBackendCapabilities(backend);
    if (
      capabilities.workflows.get !== "supported" ||
      typeof backend.getWorkflow !== "function"
    ) {
      throw new GraphExecutionError(
        `Graph execution backend '${flavour}' does not support workflow lookup`,
        "GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED",
        { backend: flavour, workflowId }
      );
    }
    return await backend.getWorkflow(workflowId, ...args);
  }

  /** Human-readable name of the active backend, for diagnostics. */
  private get backendName(): string {
    return this.client.backend.constructor?.name ?? "GraphExecutionBackend";
  }

  /**
   * SAA-193 C1 fail-closed gate. A non-local backend must not launch a
   * workflow carrying any code-mode surface unless it declares
   * `codeMode: "hostSide"` and the facade has a configured sandbox evaluator.
   * Local backends are not gated: their code-mode surfaces fail naturally
   * through the existing per-surface `GRAPH_CODE_SANDBOX_NOT_CONFIGURED` path.
   */
  private assertCodeModeSupported(
    document: GraphWorkflowDocument
  ): void {
    const backend = this.client.backend;
    if (backend.local) return;
    const surfaces = detectGraphCodeModeSurfaces(document);
    if (surfaces.length === 0) return;
    if (backend.codeMode === "unsupported") {
      throw new GraphExecutionError(
        `Graph execution backend '${this.backendName}' does not support code-mode workflows`,
        "GRAPH_CODE_MODE_UNSUPPORTED_BACKEND",
        { backend: this.backendName, surfaces }
      );
    }
    if (!this.codeSandboxEvaluator) {
      throw new GraphExecutionError(
        "Code-mode workflows require a CodeSandboxEvaluator to be registered in GraphExecutionEngineConfig.codeSandboxEvaluator",
        "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
        { backend: this.backendName, surfaces }
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
}
