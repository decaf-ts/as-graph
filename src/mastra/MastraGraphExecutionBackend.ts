/**
 * @module as-graph/mastra/MastraGraphExecutionBackend
 * @summary `@mastra/core`-translated graph execution backend (SAA-196).
 * @description The Mastra analogue of the backend seam: translates the canonical
 * document into a Mastra workflow, runs it through the injected Mastra runtime,
 * bridges the run's `fullStream` onto the facade event sink, and enforces the
 * SAA-193 resume guard conditions for suspended runs. The backend registers
 * itself under the `mastra` flavour on construction and never probes remote
 * engines. Boot configuration comes from the accumulated mastra environment
 * (SAA-836 S1, see {@link MastraEnvironment}): the lane must be enabled
 * (`MASTRA__ENGINE__ENABLED`, else `initialize` fails closed with
 * `GRAPH_MASTRA_ENGINE_DISABLED`) and the default run-level terminal timeout is
 * environment-derived (`MASTRA__ENGINE__TERMINAL_TIMEOUT_MS`) unless the host
 * config sets its own. A host-declared `MastraBackendConfig.storage` is wired
 * explicitly and verified durable (SAA-926 §6.2, see
 * {@link wireMastraStorage}), and run handles for resume are recovered through
 * the storage-backed fallback when the runtime exposes no `getRun`
 * (SAA-926 §6.3, see {@link recoverMastraRunHandle}).
 */
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import { Logging } from "@decaf-ts/logging";
import { NotFoundError } from "@decaf-ts/db-decorators";
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import { GraphExecutionEventType, GraphExecutionStatus } from "../shared/graph/constants";
import type {
  GraphBackendExecutionRequest,
  GraphBackendWorkflowSummary,
  GraphExecutionBackend,
  GraphFrameAwareEventSink,
} from "../engine/execution/GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../engine/execution/GraphExecutionBackendRegistry";
import { canAccessGraphResource } from "../engine/runs/ownership";
import { graphWorkflowOwnerOf } from "../engine/services/GraphWorkflowService";
import type { GraphExecutionResult, GraphRunId } from "../engine/types";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import { graphRunDocumentFingerprint } from "../engine/runs/GraphRunFingerprint";
import { buildGraphExecutionResult } from "../engine/execution/GraphExecutionResult";
import { MastraWorkflowCompiler } from "./MastraWorkflowCompiler";
import { MastraWorkflowManager } from "./MastraWorkflowManager";
import { MastraEventBridge } from "./MastraEventBridge";
import { recoverMastraRunHandle } from "./MastraRunRecovery";
import {
  wireMastraStorage,
  type MastraStorageWiringStatus,
} from "./MastraStorageWiring";
import { assertMastraResumeAllowed } from "./MastraResumeGuard";
import { assertMastraResumeSchemaSafe } from "./MastraSchemaConverter";
import {
  resolveMastraCapabilities,
  type MastraBackendCapabilities,
} from "./MastraCapabilities";
import { createMastraAgentRuntimeFromConfig, createMastraAgentStepHandler } from "./MastraAgentStepHandler";
import {
  GRAPH_MASTRA_ENGINE_DISABLED,
  MastraEnvironment,
} from "./MastraEnvironment";
import { createMastraHitlStepHandler } from "./MastraHitlStepHandler";
import { createMastraMcpTriggerStepHandler } from "./MastraMcpTrigger";
import { createMastraChannelTriggerStepHandlers } from "./MastraChannelTrigger";
import { createMastraChannelResponseStepHandlers } from "./MastraChannelResponse";
import { createMastraVoiceStepHandler } from "./MastraVoiceStepHandler";
import {
  wireMastraObservability,
  type MastraObservabilityHandle,
} from "./MastraObservability";
import {
  createMastraPersistence,
  jsonSafeProjection,
  type MastraPersistence,
} from "./MastraPersistence";
import { MastraMetricsGateway } from "./MastraMetricsGateway";
import {
  GRAPH_MASTRA_AGENT_UNAVAILABLE,
  GRAPH_MASTRA_EXECUTE_ABORTED,
  GRAPH_MASTRA_EXECUTE_TIMEOUT,
  GRAPH_MASTRA_UNSUPPORTED_KIND,
  MASTRA_BACKEND_FLAVOUR,
  type MastraBackendConfig,
  type MastraNodeStepHandler,
  type MastraResumeAudit,
  type MastraResumeRequest,
  type MastraSuspendStateReader,
} from "./types";

const DEFAULT_MAX_RESUME_BYTES = 64 * 1024;

/** The shape of a Mastra run's stream handle this backend relies on. */
interface MastraRunStreamLike {
  fullStream?: AsyncIterable<Record<string, unknown>>;
  result?: Promise<unknown>;
  /** The run's raw terminal status (`success`/`failed`/`canceled`/...), when exposed. */
  status?: string;
}

interface MastraRunLike {
  stream(options?: unknown): Promise<MastraRunStreamLike>;
  resume?(options?: unknown): Promise<unknown>;
  getResult?(): Promise<unknown>;
}

interface MastraWorkflowLike {
  createRun(options?: unknown): Promise<MastraRunLike>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Maps a Mastra run's terminal status (from the resolved run result
 * `{ status }` or the stream's raw `status`) onto a canonical
 * GraphExecutionStatus. A tripwire guardrail abort and an explicit failure both
 * map to FAILED.
 *
 * @param {unknown} value - The run result object (with a `status` string) or a
 * raw status string.
 * @return {GraphExecutionStatus | undefined} The canonical terminal status, or
 * `undefined` for a non-terminal status (suspended/paused) so the caller keeps
 * its prior disposition.
 */
function mastraRunTerminalStatus(
  value: unknown
): GraphExecutionStatus | undefined {
  const raw =
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value["status"] === "string"
        ? (value["status"] as string)
        : undefined;
  switch (raw) {
    case "success":
    case "succeeded":
      return GraphExecutionStatus.SUCCEEDED;
    case "failed":
    case "tripwire":
      return GraphExecutionStatus.FAILED;
    case "canceled":
    case "cancelled":
      return GraphExecutionStatus.CANCELLED;
    default:
      return undefined;
  }
}

/**
 * A translated-workflow catalogue entry. Records the canonical document together
 * with the authenticated owner that executed it (C23): the catalogue serves an
 * entry only to the owner that produced it, never to a foreign authenticated
 * caller. An entry with no recorded owner (an owner-less/standalone run) stays
 * visible to every caller, matching the service-layer
 * {@link canAccessGraphResource} owner-less visibility rule.
 */
interface MastraCatalogueEntry {
  /** The canonical workflow document received at `execute()` time. */
  document: GraphWorkflowDocument;
  /** Authenticated owner resolved at `execute()` time; absent when owner-less. */
  owner?: string;
}

/**
 * Structural check for a Decaf execution {@link Context} inside a
 * {@link MaybeContextualArg} argument list. Mirrors `@decaf-ts/core`'s own
 * `isContextLike` realm-safe duck-typing (multiple linked core builds defeat
 * `instanceof`).
 *
 * @param value - A candidate argument.
 * @returns `true` when the value is a Decaf execution context.
 */
function isMastraContextLike(value: unknown): value is Context {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.get === "function" &&
    typeof candidate.accumulate === "function" &&
    typeof candidate.override === "function" &&
    typeof candidate.toOverrides === "function" &&
    candidate.cache !== undefined
  );
}

/**
 * Resolves the caller owner from the forwarded contextual arguments (C23). The
 * catalogue methods receive the same `...args` the facade forwards to every
 * backend; the trailing context, when present, carries the authenticated principal
 * the service layer resolves with {@link graphWorkflowOwnerOf}.
 *
 * @param args - The forwarded contextual arguments.
 * @returns The caller owner, or `undefined` for owner-less callers.
 */
function mastraCallerOwnerOf(args: readonly unknown[]): string | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const candidate = args[index];
    if (isMastraContextLike(candidate)) {
      return graphWorkflowOwnerOf(candidate);
    }
  }
  return undefined;
}

// Guarantees a unique adapter alias per metrics gateway construction: the Decaf
// adapter registry rejects duplicate aliases, and a backend rebind builds a new
// gateway over a new runtime.
let MASTRA_METRICS_ADAPTER_SEQUENCE = 0;

/**
 * `@mastra/core`-translated execution backend (SAA-196). Translates the
 * canonical document into a Mastra workflow, runs it through the injected Mastra
 * runtime, bridges Mastra's `fullStream` onto the facade event sink, and enforces
 * the SAA-193 resume guard conditions. Code-mode surfaces are not executed:
 * `codeMode` is `unsupported`, so the facade fails closed before delegating.
 */
export class MastraGraphExecutionBackend
  implements GraphExecutionBackend<MastraBackendConfig>
{
  /** Translated backend: never executes in-process. */
  readonly local = false;

  /** Code-mode surfaces are rejected by the facade gate (C3). */
  readonly codeMode = "unsupported" as const;

  private compiler = new MastraWorkflowCompiler();
  private readonly documents = new Map<string, MastraCatalogueEntry>();
  private readonly runWorkflows = new Map<GraphRunId, string>();
  private runtime?: unknown;
  private managementManager?: MastraWorkflowManager;
  private suspendStateReader?: MastraSuspendStateReader;
  private observability?: MastraObservabilityHandle;
  private maxResumeBytes = DEFAULT_MAX_RESUME_BYTES;
  private terminalTimeoutMs = MastraEnvironment.mastra.engine.terminalTimeoutMs;
  private initialized = false;
  private _config?: MastraBackendConfig;
  private _storageStatus?: MastraStorageWiringStatus;
  private persistenceInstance?: MastraPersistence;
  private persistenceOwned = false;
  private persistenceBroken = false;
  private logger = Logging.for("MastraGraphExecutionBackend");

  constructor() {
    GraphExecutionBackendRegistry.register(MASTRA_BACKEND_FLAVOUR, this);
  }

  /**
   * Initializes the backend from the host configuration (SAA-836 S1: the
   * engine boots from Environment config only). Fails closed with
   * {@link GRAPH_MASTRA_ENGINE_DISABLED} when the mastra lane is disabled in
   * the environment (`MASTRA__ENGINE__ENABLED=false`). The run-level terminal
   * timeout defaults to the environment-derived
   * `MASTRA__ENGINE__TERMINAL_TIMEOUT_MS` unless the host config sets its own
   * positive value. The `core.agent` step handler is registered from an
   * explicit {@link MastraBackendConfig.agentRuntime}, else from the agent
   * map/factory — with the host decaf-model registry
   * {@link MastraBackendConfig.resolveStructuredOutputModel} passed through so
   * structured-output definitions referencing a model name convert through
   * `@decaf-ts/as-zod`; when none is supplied the kind is left to fail closed,
   * never to a fabricated echo.
   *
   * When the host declares `MastraBackendConfig.storage` (SAA-926 §6.2), it is
   * wired onto the runtime through {@link wireMastraStorage} before any step
   * handler registration; the wiring fails closed on an unwired runtime or a
   * non-durable workflows domain, and the resolved outcome is exposed via
   * {@link MastraGraphExecutionBackend.storageStatus}.
   *
   * @param config - The host-injected backend configuration.
   * @throws {GraphExecutionError} when the mastra lane is disabled by the
   *   environment, when the declared storage cannot be wired
   *   ({@link GRAPH_MASTRA_STORAGE_UNWIRED}), or when the wired storage does
   *   not resolve a durable workflows domain
   *   ({@link GRAPH_MASTRA_STORAGE_DOMAIN_INMEMORY}).
   */
  async initialize(config: MastraBackendConfig): Promise<void> {
    // SAA-836 S1: the engine boots from Environment config only, and fails
    // closed when the mastra lane is disabled (`MASTRA__ENGINE__ENABLED=false`).
    if (!MastraEnvironment.mastra.engine.enabled) {
      throw new GraphExecutionError(
        "The mastra engine lane is disabled by the environment (MASTRA__ENGINE__ENABLED=false)",
        GRAPH_MASTRA_ENGINE_DISABLED
      );
    }
    this._config = config;
    this.runtime = config.mastra;
    // Re-initializing rewires the runtime/compiler, so a previously cached
    // management surface must not survive the rebind (C7).
    this.managementManager = undefined;
    this.suspendStateReader = config.suspendStateReader;
    this.metricsGateway = undefined;
    // SAA-926 §6.2: `MastraBackendConfig.storage` was declared but never read,
    // so a host declaring durable storage silently persisted in-memory. Wire the
    // declared storage onto the runtime and fail closed when the runtime cannot
    // accept it or the resolved workflows domain is not durable.
    this._storageStatus = undefined;
    if (config.storage !== undefined) {
      this._storageStatus = await wireMastraStorage(this.runtime, config.storage);
    }
    if (typeof config.maxResumeBytes === "number" && config.maxResumeBytes > 0) {
      this.maxResumeBytes = config.maxResumeBytes;
    }
    this.terminalTimeoutMs =
      typeof config.terminalTimeoutMs === "number" &&
      config.terminalTimeoutMs > 0
        ? config.terminalTimeoutMs
        // SAA-836 S1: the engine boots from Environment config only — the
        // default terminal timeout comes from the accumulated mastra
        // environment (`MASTRA__ENGINE__TERMINAL_TIMEOUT_MS`), not a constant.
        : MastraEnvironment.mastra.engine.terminalTimeoutMs;
    const stepHandlers: MastraNodeStepHandler[] = Array.isArray(
      config.stepHandlers
    )
      ? [...config.stepHandlers]
      : [];
    // SAA-837 M1: register the real `core.agent` handler, overriding any host
    // default for that kind. Precedence: an explicit runtime, else a config-
    // backed runtime built from the agent map/factory. When none is supplied the
    // kind is left to fail closed (no handler ⇒ GRAPH_MASTRA_UNSUPPORTED_KIND, or
    // the host default's GRAPH_MASTRA_AGENT_UNAVAILABLE), never a fabricated echo.
    const agentRuntime =
      config.agentRuntime ??
      (config.agents || config.createAgent || config.memories || config.createMemory
        ? createMastraAgentRuntimeFromConfig({
            agents: config.agents,
            createAgent: config.createAgent,
            memories: config.memories,
            createMemory: config.createMemory,
          })
        : undefined);
    if (agentRuntime) {
      stepHandlers.push(
        createMastraAgentStepHandler({
          runtime: agentRuntime,
          ...(config.resolveProcessorModel
            ? { resolveProcessorModel: config.resolveProcessorModel }
            : {}),
          // SAA-836 S1: host decaf-model registry for structured-output
          // definitions (converted via @decaf-ts/as-zod).
          ...(config.resolveStructuredOutputModel
            ? { resolveModel: config.resolveStructuredOutputModel }
            : {}),
        })
      );
    }
    // SAA-836 M5: register the HITL suspending-step handler and the MCP
    // trigger handler, overriding any host default for those kinds. The MCP
    // trigger fails closed unless the host supplies the `@mastra/mcp` server
    // surface (R2 extension point); the HITL handler is mastra-native.
    stepHandlers.push(createMastraHitlStepHandler());
    stepHandlers.push(
      createMastraMcpTriggerStepHandler({
        ...(config.createMcpServer ? { createMcpServer: config.createMcpServer } : {}),
      })
    );
    // SAA-836 M6: register the channel trigger/response and voice handlers,
    // overriding any host default for those kinds. The channel surface and
    // voice surface are host-supplied extension points (R2) — without one the
    // kinds fail closed instead of fabricating platform endpoints or voice
    // capability.
    stepHandlers.push(
      ...createMastraChannelTriggerStepHandlers({
        ...(config.resolveChannelAdapter
          ? { resolveChannelAdapter: config.resolveChannelAdapter }
          : {}),
      })
    );
    stepHandlers.push(
      ...createMastraChannelResponseStepHandlers({
        ...(config.sendChannelResponse
          ? { sendChannelResponse: config.sendChannelResponse }
          : {}),
      })
    );
    stepHandlers.push(
      createMastraVoiceStepHandler({
        ...(config.resolveVoice ? { resolveVoice: config.resolveVoice } : {}),
      })
    );
    this.compiler = new MastraWorkflowCompiler({ stepHandlers });
    // SAA-836 O1: wire the mastra engine's observability layer onto the real
    // runtime — langfuse as the default and always-present export target plus
    // the OUR-node isolation exporter. Fails closed on credentials (gate C)
    // when the observability lane is enabled on a mastra-native runtime;
    // duck-typed runtimes without a mastra `registerExporter` surface (test
    // doubles) are skipped so the general engine keeps booting them unchanged.
    this.observability = await wireMastraObservability(this.runtime);
    this.initialized = true;
  }

  get capabilities(): MastraBackendCapabilities {
    return resolveMastraCapabilities();
  }

  /**
   * The workflow-management surface over the wired real `@mastra/core` runtime
   * (SAA-346). The manager translates canonical documents through the same
   * compiler the backend executes with, so a created/updated workflow is the one
   * `execute` runs. Every operation fails closed when the wired runtime exposes
   * no real Mastra method.
   */
  get management(): MastraWorkflowManager {
    // Cache the manager per backend (C7): revisions recorded at `create` must
    // survive the next `management` access, otherwise `get`/`serialize` silently
    // drop the wrapper-tracked revision.
    if (!this.managementManager) {
      this.managementManager = new MastraWorkflowManager({
        runtime: this.runtime,
        compiler: this.compiler,
      });
    }
    return this.managementManager;
  }

  /**
   * The owner-scoped metrics gateway over the wired runtime's real mastra
   * storage (SAA-836 S2): read-only agent run/score/trace metrics served
   * through the dedicated decaf adapter/statement/paginator, with C23
   * foreign-owner deny resolved against the same catalogue ownership map the
   * workflow lookups use. Storage resolution itself fails closed inside the
   * gateway when the runtime exposes no storage or the queried domain is absent.
   */
  get metrics(): MastraMetricsGateway {
    // Cache per backend (C7): `initialize` rewires the runtime, so a gateway
    // bound to a previous runtime must not survive the rebind.
    if (!this.metricsGateway) {
      this.metricsGateway = new MastraMetricsGateway({
        mastra: this.runtime,
        ownership: {
          resolveWorkflow: (workflowId) => {
            const entry = this.documents.get(workflowId);
            if (!entry) return undefined;
            return { known: true, ...(entry.owner ? { owner: entry.owner } : {}) };
          },
        },
        alias: `mastra-metrics-${++MASTRA_METRICS_ADAPTER_SEQUENCE}`,
      });
    }
    return this.metricsGateway;
  }

  private metricsGateway?: MastraMetricsGateway;

  /**
   * Lists the translated workflows visible to the requesting caller (C23). The
   * catalogue is ownership-filtered with the same
   * {@link canAccessGraphResource} predicate the service layer uses: a document
   * executed by a named owner is visible only to that owner, an owner-less
   * document stays visible to every caller, and an anonymous caller sees only
   * owner-less documents. The caller owner is resolved from the forwarded
   * contextual arguments; a missing context denies foreign-owner rows.
   *
   * @param args - Optional decaf contextual arguments carrying the caller principal.
   * @returns Workflow summaries visible to the caller.
   */
  async listWorkflows(
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphBackendWorkflowSummary[]> {
    const callerOwner = mastraCallerOwnerOf(args);
    return [...this.documents.values()]
      .filter((entry) =>
        canAccessGraphResource({ owner: entry.owner }, callerOwner)
      )
      .map((entry) => ({
        id: entry.document.id,
        ...(entry.document.name ? { name: entry.document.name } : {}),
      }));
  }

  /**
   * Reads a single translated workflow document, enforcing the C23 ownership
   * predicate. An unknown id and a foreign-owner id both fail closed: an unknown
   * id keeps the backend's existing translated-catalogue error, and a foreign-owner
   * id is denied with a constant `NotFoundError` that maps to `404` and never
   * carries `GraphExecutionError.details`, so a foreign caller cannot read
   * another owner's canonical document.
   *
   * @param workflowId - The canonical workflow id to read.
   * @param args - Optional decaf contextual arguments carrying the caller principal.
   * @returns The canonical workflow document.
   * @throws {GraphExecutionError} when no translated workflow exists for the id.
   * @throws {NotFoundError} when the workflow is owned by another user.
   */
  async getWorkflow(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowDocument> {
    const callerOwner = mastraCallerOwnerOf(args);
    const entry = this.documents.get(workflowId);
    if (!entry) {
      throw new GraphExecutionError(
        `Mastra backend has no translated workflow '${workflowId}'`,
        GRAPH_MASTRA_UNSUPPORTED_KIND,
        { workflowId }
      );
    }
    if (!canAccessGraphResource({ owner: entry.owner }, callerOwner)) {
      throw new NotFoundError(
        `No graph workflow found for workflowId '${workflowId}'`
      );
    }
    return entry.document;
  }

  /**
   * Seeds canonical workflow documents into the translated-workflow catalogue so
   * they are served by {@link listWorkflows}/{@link getWorkflow} exactly like a
   * document recorded by {@link execute}. Seeded entries are owner-less, so the
   * C23 filter keeps them visible to every caller (the owner-less visibility
   * rule). Fails closed when the backend has not been initialized.
   *
   * @param documents - The canonical documents to register.
   * @returns The seeded workflow summaries.
   * @throws {GraphExecutionError} when the backend is not initialized.
   */
  async seedWorkflows(
    documents: readonly GraphWorkflowDocument[]
  ): Promise<GraphBackendWorkflowSummary[]> {
    if (!this.initialized) {
      throw new GraphExecutionError(
        "MastraGraphExecutionBackend must be initialized before seeding workflows",
        GRAPH_MASTRA_UNSUPPORTED_KIND
      );
    }
    const summaries: GraphBackendWorkflowSummary[] = [];
    for (const document of documents) {
      this.documents.set(document.id, { document });
      summaries.push({
        id: document.id,
        ...(document.name ? { name: document.name } : {}),
      });
    }
    return summaries;
  }

  async execute(
    request: GraphBackendExecutionRequest,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphExecutionResult> {
    const sink = request.events as GraphFrameAwareEventSink;
    const frame = sink.frame;
    if (!frame) {
      throw new GraphExecutionError(
        "MastraGraphExecutionBackend requires the frame-bound event sink created by GraphExecutionEngine",
        GRAPH_MASTRA_UNSUPPORTED_KIND,
        { workflowId: request.document.id }
      );
    }
    const runId = frame.runId;
    const owner = this.callerOwnerOf(request, args);
    this.documents.set(request.document.id, {
      document: request.document,
      ...(owner ? { owner } : {}),
    });
    this.runWorkflows.set(runId, request.document.id);
    const compiled = this.compiler.compile(request.document);
    // SAA-836 O1: record the cache ledger entry and atomically invalidate
    // stale entries for this document (gate A: recompilation only on
    // document change). Never fails the run.
    await this.recordCacheLedger(compiled, request.document.id);

    // SAA-836 O1: bind the compiled workflow to the wired runtime before the
    // run starts, so the run executes under the mastra engine's own
    // observability context (the root `workflow_run` span is created against
    // the registered runtime's observability) and every engine signal reaches
    // the configured exporters — langfuse by default. A runtime without the
    // mastra workflow-registration surface (a duck-typed test double) keeps
    // the direct compiled-workflow run path.
    const workflow = this.bindCompiledWorkflow(
      compiled
    ) as MastraWorkflowLike;
    // SAA-836 O1: the OUR-node isolation exporter attributes mastra's
    // workflow-step spans to the canonical nodes of this document.
    this.observability?.decafExporter.trackNodes(
      (request.document.nodes ?? []).map((node) => ({
        id: node.id,
        kind: node.kind,
      }))
    );
    if (typeof workflow.createRun !== "function") {
      throw new GraphExecutionError(
        "Mastra backend received a workflow without a createRun method",
        GRAPH_MASTRA_AGENT_UNAVAILABLE,
        { workflowId: request.document.id }
      );
    }

    const bridge = new MastraEventBridge({
      runId,
      parentRunId: request.options.parentRunId,
      workflowId: request.document.id,
      document: request.document,
      sink,
      path: [],
    });

    let status: GraphExecutionStatus = GraphExecutionStatus.SUCCEEDED;
    let resolvedRunOutput: unknown = undefined;
    const signal = request.options?.abortSignal;
    try {
      const run = await workflow.createRun({ runId });
      const stream = await run.stream({
        inputData: request.inputs,
        ...(signal ? { abortSignal: signal } : {}),
      });
      const execution = (async (): Promise<void> => {
        if (stream.fullStream) {
          await bridge.attach(stream.fullStream);
        }
        if (typeof run.getResult === "function") {
          resolvedRunOutput = await run.getResult();
        } else if (stream.result) {
          resolvedRunOutput = await stream.result;
        }
      })();
      await this.awaitTerminal(execution, signal, request.document.id);
      // A Mastra run does not reject on a step failure: it resolves with a
      // terminal result and closes the stream with a `workflow-finish` event. The
      // returned status must therefore be read from that terminal outcome, never
      // assumed from the bare fact that the await resolved. The bridge is the
      // authority because it emitted the matching terminal event; the run's own
      // result/status is the fallback when the stream was not observed.
      const terminal =
        bridge.terminalStatus ??
        mastraRunTerminalStatus(resolvedRunOutput) ??
        mastraRunTerminalStatus(stream.status);
      if (terminal) status = terminal;
    } catch (error) {
      status = GraphExecutionStatus.FAILED;
      await sink.emit({
        type: GraphExecutionEventType.WORKFLOW_FAILED,
        status,
        error: this.errorPayload(error),
      });
    }

    // SAA-836 O1: persist a versioned replay snapshot of the terminal
    // outcome (replays layer) before the frame closes. Never fails the run.
    await this.recordReplaySnapshot({
      runId,
      workflowId: request.document.id,
      documentFingerprint: compiled.fingerprint,
      status,
      resolvedRunOutput,
    });

    frame.finish();
    return buildGraphExecutionResult(
      frame,
      request.document,
      request.inputs,
      status,
      { backend: MASTRA_BACKEND_FLAVOUR, documentFingerprint: compiled.fingerprint }
    );
  }

  /**
   * Bounds the translated run's terminal wait by the backend's run-level
   * `terminalTimeoutMs` and the caller's cancellation signal, mirroring the
   * Dagster observation bound. Exceeding the timeout fails closed with
   * {@link GRAPH_MASTRA_EXECUTE_TIMEOUT}; an abort fails closed with
   * {@link GRAPH_MASTRA_EXECUTE_ABORTED}. The underlying run is not force-killed
   * (Mastra owns run lifecycle), but the backend stops awaiting it so the run
   * slot and event bridge are released and the run cannot pin the process.
   *
   * @param execution - The in-flight run/stream/result promise.
   * @param signal - The caller's cancellation signal, when supplied.
   * @param workflowId - The workflow id the run belongs to (for error details).
   * @returns Resolves once the run terminates normally.
   * @throws {GraphExecutionError} on timeout or abort.
   */
  private async awaitTerminal(
    execution: Promise<void>,
    signal: AbortSignal | undefined,
    workflowId: string
  ): Promise<void> {
    const timeoutMs = this.terminalTimeoutMs;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        settle();
      };
      const onAbort = (): void =>
        finish(() =>
          reject(
            new GraphExecutionError(
              `Mastra run for workflow '${workflowId}' was aborted`,
              GRAPH_MASTRA_EXECUTE_ABORTED,
              { workflowId }
            )
          )
        );
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(
          () =>
            finish(() =>
              reject(
                new GraphExecutionError(
                  `Mastra run for workflow '${workflowId}' did not terminate within ${timeoutMs}ms`,
                  GRAPH_MASTRA_EXECUTE_TIMEOUT,
                  { workflowId, terminalTimeoutMs: timeoutMs }
                )
              )
            ),
          timeoutMs
        );
      }
      execution.then(
        () => finish(resolve),
        (error) => finish(() => reject(error))
      );
    });
  }

  /**
   * Binds a compiled workflow to the wired mastra runtime so its runs execute
   * under the runtime's own observability context (SAA-836 O1). The compiler
   * caches by document id and fingerprint, so a recompiled document either
   * matches the registered instance (no-op) or replaces it (`removeWorkflow`
   * + `addWorkflow`) before the run starts. Runtimes without the mastra
   * workflow-registration surface (duck-typed test doubles) return the
   * unbound compiled workflow, keeping the direct run path.
   *
   * @param compiled - The compilation to bind.
   * @returns The workflow to run: the runtime-bound compiled workflow when
   *   the runtime is mastra-native, else the unbound compiled workflow.
   */
  private bindCompiledWorkflow(
    compiled: ReturnType<MastraWorkflowCompiler["compile"]>
  ): unknown {
    const workflow = compiled.workflow;
    const runtime = this.runtime;
    if (!isRecord(runtime)) return workflow;
    const addWorkflow = runtime["addWorkflow"];
    const getWorkflow = runtime["getWorkflow"];
    if (typeof addWorkflow !== "function" || typeof getWorkflow !== "function") {
      return workflow;
    }
    const existing = (() => {
      // A real mastra runtime throws `MASTRA_GET_WORKFLOW_BY_ID_NOT_FOUND`
      // for an unregistered id; treat that as "not registered".
      try {
        return (getWorkflow as (id: string) => unknown).call(
          runtime,
          compiled.workflowId
        );
      } catch {
        return undefined;
      }
    })();
    if (existing !== workflow) {
      const removeWorkflow = runtime["removeWorkflow"];
      if (typeof removeWorkflow === "function" && existing !== undefined) {
        (removeWorkflow as (id: string) => unknown).call(
          runtime,
          compiled.workflowId
        );
      }
      (addWorkflow as (workflow: unknown, key?: string) => void).call(
        runtime,
        workflow,
        compiled.workflowId
      );
    }
    return workflow;
  }

  /**
   * Resumes a suspended Mastra run after enforcing the SAA-193 resume guard
   * (C13/C15/C16/C17/C18). The Mastra run snapshot is authoritative for the
   * suspended state; the current document fingerprint must match the snapshot
   * (C17). Returns the C18 audit record, never the raw `resumeData`.
   */
  async resume(
    runId: GraphRunId,
    request: MastraResumeRequest,
    ..._args: MaybeContextualArg<Context>
  ): Promise<MastraResumeAudit> {
    const reader = this.suspendStateReader;
    if (!reader) {
      throw new GraphExecutionError(
        "Mastra backend has no suspendStateReader configured; resume is not available",
        GRAPH_MASTRA_UNSUPPORTED_KIND,
        { runId }
      );
    }
    const snapshot = await reader.readRunState(runId, ..._args);
    if (!snapshot) {
      throw new GraphExecutionError(
        `Mastra backend has no suspended snapshot for run '${runId}'`,
        "GRAPH_MASTRA_RESUME_STATE_INVALID",
        { runId }
      );
    }
    const document = this.documents.get(snapshot.workflowId)?.document;
    if (!document) {
      throw new GraphExecutionError(
        `Mastra backend has no translated workflow '${snapshot.workflowId}'`,
        "GRAPH_MASTRA_RESUME_STATE_INVALID",
        { runId, workflowId: snapshot.workflowId }
      );
    }
    const allowlistedSteps = snapshot.suspendedSteps;
    const suspendedStep = request.step ?? snapshot.suspendedSteps[0] ?? "";
    const suspendedNode = (document.nodes ?? []).find(
      (node) => node.id === suspendedStep
    );
    const declaredResumeSchema = suspendedNode?.parameters?.["resumeSchema"];
    const resumeSchema = declaredResumeSchema
      ? assertMastraResumeSchemaSafe(declaredResumeSchema as never)
      : undefined;
    const audit = assertMastraResumeAllowed(
      request,
      {
        runId,
        workflowId: snapshot.workflowId,
        documentFingerprint: snapshot.documentFingerprint,
        status: snapshot.status,
        step: request.step ?? snapshot.suspendedSteps[0] ?? "",
        forEachIndex:
          request.forEachIndex ??
          snapshot.suspendedForEachIndexes?.[
            request.step ?? snapshot.suspendedSteps[0] ?? ""
          ],
        state: snapshot,
      },
      {
        maxResumeBytes: this.maxResumeBytes,
        allowlistedSteps,
        documentFingerprint: graphRunDocumentFingerprint(document),
        ...(resumeSchema ? { resumeSchema } : {}),
      }
    );

    const run = await this.loadRun(runId);
    if (!run || typeof run.resume !== "function") {
      throw new GraphExecutionError(
        `Mastra backend cannot resume run '${runId}': no resumable run handle`,
        GRAPH_MASTRA_UNSUPPORTED_KIND,
        { runId }
      );
    }
    await run.resume({
      step: audit.step,
      resumeData: request.resumeData,
      ...(audit.forEachIndex !== undefined
        ? { forEachIndex: audit.forEachIndex }
        : {}),
    });
    return audit;
  }

  /**
   * Resolves the owner recorded for a run (C23). The facade-resolved principal
   * bound onto `options.auth` is authoritative; when absent (a direct backend call)
   * the owner is resolved from the forwarded contextual arguments. Returns
   * `undefined` for owner-less runs, matching the service-layer owner-less
   * visibility rule.
   *
   * @param request - The execution request carrying the facade-resolved options.
   * @param args - The forwarded contextual arguments.
   * @returns The run's owner, or `undefined` when owner-less.
   */
  private callerOwnerOf(
    request: GraphBackendExecutionRequest,
    args: MaybeContextualArg<Context>
  ): string | undefined {
    const authUser = request.options?.auth?.user;
    if (typeof authUser === "string" && authUser.length > 0) {
      return authUser;
    }
    return mastraCallerOwnerOf(args);
  }

  /**
   * Releases the per-run catalogue state (C23). Removes the run's workflow
   * association and drops the translated document once no other live run still
   * references it, so the process-lifetime catalogue cannot grow unbounded and
   * widen the BOLA surface over time.
   *
   * @param runId - The completed run whose resources are released.
   */
  async release(runId: GraphRunId): Promise<void> {
    const workflowId = this.runWorkflows.get(runId);
    if (workflowId === undefined) return;
    this.runWorkflows.delete(runId);
    const stillReferenced = [...this.runWorkflows.values()].includes(workflowId);
    if (!stillReferenced) {
      this.documents.delete(workflowId);
    }
  }

  async dispose(): Promise<void> {
    this.compiler.clear();
    this.documents.clear();
    this.runWorkflows.clear();
    this.runtime = undefined;
    this.managementManager = undefined;
    if (this.observability) {
      await this.observability.flush();
      await this.observability.shutdown();
      this.observability = undefined;
    }
    if (this.persistenceInstance && this.persistenceOwned) {
      await this.persistenceInstance.shutdown();
    }
    this.persistenceInstance = undefined;
    this.persistenceOwned = false;
    this.persistenceBroken = false;
    this.terminalTimeoutMs = MastraEnvironment.mastra.engine.terminalTimeoutMs;
    this.initialized = false;
  }

  /**
   * The routed per-layer persistence surface (SAA-836 O1), when it resolved.
   * The host-supplied surface ({@link MastraBackendConfig.persistence}) takes
   * precedence; otherwise the Environment-routed surface
   * (`MASTRA__PERSISTENCE__*`: replays → `fs`, cache → `ram`, pins → `fs`)
   * is created lazily on first use so hosts that never record pay nothing.
   * Undefined after a routing failure: persistence recording is auxiliary
   * (fail-open), while a restore of a missing snapshot still fails closed
   * inside the repository (R7).
   */
  get persistence(): MastraPersistence | undefined {
    return this.persistenceInstance;
  }

  /** Resolves the persistence surface, memoized and fail-open on routing failure. */
  private async persistenceFor(): Promise<MastraPersistence | undefined> {
    if (this.persistenceBroken) return undefined;
    if (this.persistenceInstance) return this.persistenceInstance;
    const hostPersistence = this._config?.persistence;
    if (hostPersistence) {
      this.persistenceInstance = hostPersistence;
      this.persistenceOwned = false;
      return this.persistenceInstance;
    }
    try {
      this.persistenceInstance = await createMastraPersistence();
      this.persistenceOwned = true;
      return this.persistenceInstance;
    } catch (error) {
      this.persistenceBroken = true;
      this.logger
        ?.for({ scope: "persistence" })
        .warn(`[mastra-persistence] routing failed; recording disabled: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Records the compiled-workflow cache ledger entry for a document (cache
   * layer, `ram` by default) and invalidates stale entries compiled from a
   * different fingerprint — the atomic cache invalidation on document change
   * (gate A: recompilation only when the document changes, never per run).
   * Ledger failures never fail the run (fail-open recording).
   */
  private async recordCacheLedger(compiled: { fingerprint: string }, workflowId: string): Promise<void> {
    const persistence = await this.persistenceFor();
    if (!persistence) return;
    try {
      await persistence.cache.record(workflowId, compiled.fingerprint);
      await persistence.cache.invalidate(workflowId, compiled.fingerprint);
    } catch (error) {
      this.logger
        ?.for({ scope: "persistence", layer: "cache" })
        .warn(`[mastra-persistence] cache ledger recording failed: ${String(error)}`);
    }
  }

  /**
   * Records a versioned replay snapshot of a run's terminal outcome (replays
   * layer, `fs` by default): a JSON-safe projection of the resolved run
   * output, status and fingerprint — restorable through
   * `persistence.replays.restore(runId, version?)`. Recording failures never
   * fail the run (fail-open recording).
   */
  private async recordReplaySnapshot(params: {
    runId: GraphRunId;
    workflowId: string;
    documentFingerprint: string;
    status: GraphExecutionStatus;
    resolvedRunOutput: unknown;
  }): Promise<void> {
    const persistence = await this.persistenceFor();
    if (!persistence) return;
    try {
      await persistence.replays.record({
        runId: params.runId,
        workflowId: params.workflowId,
        documentFingerprint: params.documentFingerprint,
        status: params.status,
        payload: {
          status: params.status,
          output: jsonSafeProjection(params.resolvedRunOutput),
        },
      });
    } catch (error) {
      this.logger
        ?.for({ scope: "persistence", layer: "replays" })
        .warn(`[mastra-persistence] replay recording failed: ${String(error)}`);
    }
  }

  /**
   * The configuration most recently resolved by {@link initialize}. Exposed so
   * `GraphExecutionEngine.initialize` can merge its facade-owned collaborators
   * over the host's keys (`mastra`, `stepHandlers`, `suspendStateReader`, ...)
   * instead of dropping them when it re-initializes the backend at boot.
   */
  get config(): MastraBackendConfig | undefined {
    return this._config;
  }

  /** Whether {@link initialize} has resolved. */
  get ready(): boolean {
    return this.initialized;
  }

  /**
   * The storage-wiring status resolved by the last {@link initialize} when the
   * host declared `MastraBackendConfig.storage` (SAA-926 §6.2); `undefined`
   * when the host declared no storage config. The acceptance seam for the
   * "storage configured and durable" check: `domains.workflows` must not be
   * `in-memory`/`absent` on a production host.
   */
  get storageStatus(): MastraStorageWiringStatus | undefined {
    return this._storageStatus;
  }

  private async loadRun(runId: GraphRunId): Promise<MastraRunLike | undefined> {
    const runtime = this.runtime;
    if (!isRecord(runtime)) return undefined;
    const getRun = runtime["getRun"];
    if (typeof getRun === "function") {
      const run = await (getRun as (id: string) => unknown).call(runtime, runId);
      return isRecord(run) ? (run as unknown as MastraRunLike) : undefined;
    }
    // SAA-926 §6.3: @mastra/core 1.77.0 exposes no public `getRun` on the
    // `Mastra` class, so a plain runtime left resume failing closed. Recover
    // the resumable run handle through mastra's own restart-recovery pattern:
    // resolve the persisted run record from the configured storage workflows
    // domain, then rebind the run id onto the live workflow via
    // `createRun({ runId })`.
    const recovered = await recoverMastraRunHandle(runtime, runId);
    return isRecord(recovered) ? (recovered as unknown as MastraRunLike) : undefined;
  }

  private errorPayload(error: unknown): {
    name: string;
    message: string;
    code?: string;
  } {
    if (error instanceof Error) {
      const graphCode = (error as unknown as { graphCode?: unknown }).graphCode;
      const code = (error as unknown as { code?: unknown }).code;
      const normalised =
        typeof graphCode === "string"
          ? graphCode
          : typeof code === "number"
            ? String(code)
            : typeof code === "string"
              ? code
              : undefined;
      return {
        name: error.name,
        message: error.message,
        ...(normalised !== undefined ? { code: normalised } : {}),
      };
    }
    return { name: "MastraError", message: String(error) };
  }
}
