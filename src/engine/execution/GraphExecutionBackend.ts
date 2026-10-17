/**
 * @module as-graph/execution/GraphExecutionBackend
 * @summary Pluggable graph execution backend seam (DECAF-50 §4.9).
 * @description Defines the engine-agnostic execution seam that
 * {@link GraphExecutionEngine} delegates to after validation, catalogue
 * resolution, authorization, and topological planning. The contract is patterned
 * on Decaf's persistence adapters: `GraphExecutionBackend` is the `Adapter`
 * analogue and {@link LocalGraphExecutionBackend} is the built-in `RamAdapter`
 * analogue (the extracted reference interpreter). Remote/translated backends
 * (Dagster, Mastra) receive the canonical document for translation and the
 * resolved plan for built-in execution, but can never bypass the facade's
 * pre-execution gate: validation/resolution/auth always happen against the
 * trusted catalogue before any backend runs.
 */
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import type {
  GraphExecutionEvent,
  GraphWorkflowDocument,
} from "../../shared/graph";
import { GraphExecutionEventType } from "../../shared/graph";
import type { GraphExecutionPlan } from "../planning/GraphExecutionPlan";
import type {
  GraphExecutionOptions,
  GraphExecutionResult,
  GraphExecutionValues,
  GraphRunId,
} from "../types";
import type { GraphExecutionEventEmitter } from "../events/GraphExecutionEventEmitter";
import type { GraphExecutionEventFactory } from "../events/GraphExecutionEventFactory";
import type { GraphExecutionFrame } from "./GraphExecutionFrame";
import type { GraphExecutionEngine } from "./GraphExecutionEngine";
import type { CodeSandboxEvaluator } from "./CodeSandboxEvaluator";

/**
 * How a {@link GraphExecutionBackend} handles code-mode workflow surfaces.
 *
 * Code-mode surfaces are `CodeCondition`s on any flow-control carrier,
 * `core.utility.code` nodes, `GraphValueTemplate` parameters, and expression
 * input bindings (SAA-193 C1). The facade detects them and fails closed before
 * delegating to any backend with `local === false`:
 *
 * - `hostSide`: the host executes code-mode surfaces through the facade-owned
 *   `CodeSandboxEvaluator`; the facade rejects the run with
 *   `GRAPH_CODE_SANDBOX_NOT_CONFIGURED` when no evaluator is configured.
 * - `unsupported`: the backend cannot execute code-mode surfaces at all; the
 *   facade rejects the run with `GRAPH_CODE_MODE_UNSUPPORTED_BACKEND` before any
 *   remote launch.
 */
export type GraphCodeMode = "hostSide" | "unsupported";

/** Whether an optional backend capability is supported. */
export type GraphBackendCapabilityStatus = "supported" | "not_supported";

/**
 * Engine-agnostic capability metadata a backend declares. Hosts and servers read
 * this to surface what the active backend can do without probing it.
 */
export interface GraphBackendCapabilities {
  /** Code-mode handling (mirrors {@link GraphExecutionBackend.codeMode}). */
  codeMode: GraphCodeMode;
  /** Backend workflow listing/lookup support. */
  workflows: {
    list: GraphBackendCapabilityStatus;
    get: GraphBackendCapabilityStatus;
  };
}

/** A workflow summary surfaced by backend workflow listing. */
export interface GraphBackendWorkflowSummary {
  /** Canonical workflow id. */
  id: string;
  /** Display name. */
  name?: string;
  /** Last update timestamp, when the backing store exposes one. */
  updatedAt?: Date;
}

/**
 * Minimal workflow catalogue record a {@link GraphBackendWorkflowStore} lists.
 * `GraphWorkflowModel` structurally satisfies it.
 */
export interface GraphBackendWorkflowRecord {
  /** Canonical workflow id. */
  workflowId: string;
  /** Display name. */
  name?: string;
  /** Last update timestamp, when the backing store exposes one. */
  updatedAt?: Date;
}

/**
 * Workflow listing/lookup port the built-in local backend reads through. The
 * existing `GraphWorkflowService` structurally satisfies it; hosts pass their
 * service instance into `GraphExecutionEngineConfig.workflowStore`.
 */
export interface GraphBackendWorkflowStore {
  /** Lists the workflows visible to the requesting principal. */
  listWorkflows(
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphBackendWorkflowRecord[]>;
  /** Reads a single canonical workflow document. */
  getDocument(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowDocument>;
  /**
   * Persists a canonical workflow document (the seed surface). Optional: a
   * read-only store omits it, and the backend's `seedWorkflows` then fails
   * closed instead of silently dropping the seeds. `GraphWorkflowService`
   * structurally satisfies it.
   */
  saveDocument?(
    workflowId: string,
    document: GraphWorkflowDocument,
    ...args: MaybeContextualArg<Context>
  ): Promise<unknown>;
  /**
   * Boot-seed surface: persists a canonical workflow document, treating an
   * existing foreign-owned row as a skip rather than a hard failure (F2
   * availability fix). Optional; when present the local backend prefers it over
   * {@link saveDocument} for its host-boot seed so a fixture id a durable store
   * already holds as a user-owned row cannot fail host bootstrap. Request-path
   * writes never use it — they stay fail-closed through `saveDocument`.
   */
  seedDocument?(
    workflowId: string,
    document: GraphWorkflowDocument,
    ...args: MaybeContextualArg<Context>
  ): Promise<unknown>;
}

/**
 * Facade-owned event sink handed to a backend. The facade owns event
 * sequencing (id/sequence/timestamp) and observer dispatch; a backend reports
 * every transition by calling {@link GraphExecutionEventSink.emit} with a
 * partial event.
 */
export interface GraphExecutionEventSink {
  /** Enriches, sequences, records, and dispatches a partial event. */
  emit(event: Partial<GraphExecutionEvent>): Promise<void>;
  /** Dispatches an already-built event to all registered observers. */
  updateObservers(event: GraphExecutionEvent): Promise<void>;
}

/**
 * Request passed to a {@link GraphExecutionBackend}. Carries both the canonical
 * document (the translation source for remote backends) and the resolved plan
 * (what built-in backends execute).
 */
export interface GraphBackendExecutionRequest {
  /** The canonical workflow document (translation source). */
  document: GraphWorkflowDocument;
  /** The resolved, topologically layered execution plan. */
  plan: GraphExecutionPlan;
  /** Workflow input values keyed by input port id. */
  inputs: GraphExecutionValues;
  /** Effective execution options (already merged with engine defaults). */
  options: GraphExecutionOptions;
  /** Facade-owned event sink: the backend reports all transitions here. */
  events: GraphExecutionEventSink;
}

/**
 * Engine-agnostic resume request for a suspended run (SAA-196 C14). The payload
 * is untrusted: a resume-capable backend validates it (JSON-safe, byte-capped,
 * schema-checked against the suspended revision) before handing it to the engine.
 */
export interface GraphResumeRequest {
  /** Step id to resume; defaults to the snapshot's single suspended step. */
  step?: string;
  /** Untrusted resume payload supplied by the caller. */
  resumeData?: Record<string, unknown>;
  /** Per-iteration index when resuming inside a `foreach`. */
  forEachIndex?: number;
}

/**
 * Engine-agnostic C18 audit record returned by a resume. Carries the caller, run
 * and step identity plus a hash/size of the resume payload — never the raw
 * `resumeData` — so every resume is auditable without leaking secrets.
 */
export interface GraphResumeAudit {
  /** Resolved caller identity; `null` for anonymous callers. */
  caller?: string | null;
  /** Canonical run id that was resumed. */
  runId: GraphRunId;
  /** Workflow id the resumed run belongs to. */
  workflowId?: string;
  /** Step id the run was resumed at. */
  step?: string;
  /** Per-iteration index when the run resumed inside a `foreach`. */
  forEachIndex?: number;
  /** Stable hash of the resume payload (never the raw payload). */
  resumeDataHash?: string;
  /** Serialized byte size of the resume payload. */
  resumeDataBytes?: number;
  /** ISO timestamp of the accepted resume. */
  at?: string;
}

/**
 * The pluggable graph execution seam (the Decaf `Adapter` analogue). Owns
 * exactly one responsibility: given the resolved plan and/or canonical document,
 * run it and report results/events through the request's sink.
 *
 * @typeParam CONFIG - Backend-specific initialization configuration.
 */
export interface GraphExecutionBackend<
  CONFIG extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Resolves the backend's runtime configuration. Called by the facade during
   * `GraphExecutionEngine.initialize`.
   *
   * @param config - Backend-specific configuration.
   * @param args - Optional decaf contextual arguments.
   */
  initialize(
    config: CONFIG,
    ...args: MaybeContextualArg<Context>
  ): Promise<void>;
  /**
   * The backend-specific configuration most recently resolved by
   * {@link initialize}, when the backend retains it. The facade reads this during
   * `GraphExecutionEngine.initialize` and merges its own facade-owned keys over
   * it, so a host that configured the backend directly before booting the engine
   * (e.g. `backend.initialize({ mastra, stepHandlers, suspendStateReader })`) does
   * not lose that wiring when the facade initializes the backend.
   *
   * Facade-owned keys (`engine`, `valueAdapter`, `codeSandboxEvaluator`,
   * `workflowStore`) win on collision: the facade is the authority for the
   * collaborators it owns, while every other host key survives. Backends without
   * host-supplied configuration (the built-in local backend) may omit this.
   */
  readonly config?: CONFIG;
  /** Whether this backend executes locally (in-process). */
  readonly local: boolean;
  /**
   * How this backend handles code-mode surfaces (SAA-193 C1). Required so the
   * facade can fail closed before delegating a code-mode workflow to a non-local
   * backend instead of launching it and discovering the limitation remotely.
   */
  readonly codeMode: GraphCodeMode;
  /**
   * Optional capability metadata. When omitted the facade derives capabilities
   * from the declared `codeMode` and the presence of the optional catalogue
   * methods, so an unsupported operation is reported as `not_supported` rather
   * than silently returning an empty result.
   */
  readonly capabilities?: GraphBackendCapabilities;
  /**
   * Lists the workflows this backend can surface, when supported. Backends
   * without a catalogue omit this method (or declare `not_supported`).
   */
  listWorkflows?(
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphBackendWorkflowSummary[]>;
  /**
   * Looks up a single canonical workflow document, when supported. Backends
   * without a catalogue omit this method (or declare `not_supported`).
   */
  getWorkflow?(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowDocument>;
  /**
   * Seeds canonical workflow documents into this backend's own catalogue so
   * they are served by {@link listWorkflows}/{@link getWorkflow}. The host
   * supplies its fixture registry at boot and the backend registers the
   * documents through its own engine-dependent store (persistence for the local
   * backend, translated catalogue for Mastra, the read-only catalogue for
   * Dagster). Returns the seeded summaries. A backend without a writable
   * catalogue omits this method; the facade fails closed rather than silently
   * dropping the seeds.
   */
  seedWorkflows?(
    documents: readonly GraphWorkflowDocument[],
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphBackendWorkflowSummary[]>;
  /**
   * Executes a validated/resolved workflow.
   *
   * @param request - The execution request (document, plan, inputs, options, sink).
   * @param args - Optional decaf contextual arguments.
   * @returns The complete execution result.
   */
  execute(
    request: GraphBackendExecutionRequest,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphExecutionResult>;
  /** Cancels a run, when the backend supports it. */
  cancel?(runId: GraphRunId, reason?: string): boolean | Promise<boolean>;
  /**
   * Resumes a suspended run, when the backend supports suspend/resume (SAA-196
   * extension point). Returns the C18 audit record. A backend that cannot resume
   * omits this method; the facade fails closed rather than silently no-op.
   */
  resume?(
    runId: GraphRunId,
    request: GraphResumeRequest,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphResumeAudit>;
  /** Releases resources associated with a run, when supported. */
  release?(runId: GraphRunId): void | Promise<void>;
  /** Disposes the backend and its resources, when supported. */
  dispose?(): void | Promise<void>;
}

/**
 * Facade-owned sink extension carrying the per-run execution frame, the shared
 * event factory, the owning engine, and the code sandbox evaluator. The built-in
 * {@link LocalGraphExecutionBackend} reads these to execute the plan without
 * duplicating facade-owned run state or event sequencing. This is an internal
 * extension of the public {@link GraphExecutionEventSink} contract: remote
 * backends only ever need the two public methods.
 */
export interface GraphFrameAwareEventSink extends GraphExecutionEventSink {
  /** The facade's stateful event factory (single sequencing authority). */
  readonly eventFactory: GraphExecutionEventFactory;
  /** The owning execution engine, exposed to node contexts. */
  readonly engine: GraphExecutionEngine;
  /** The facade's code sandbox evaluator, when configured. */
  readonly codeSandboxEvaluator?: CodeSandboxEvaluator;
  /** The run frame, once the facade has bound it. */
  readonly frame?: GraphExecutionFrame;
  /** Binds the run frame after planning; workflow events are then recorded. */
  bindFrame(frame: GraphExecutionFrame): void;
}

/**
 * Options used to construct a {@link GraphEngineEventSink}.
 */
export interface GraphEngineEventSinkOptions {
  /** Unique id of the current run. */
  runId: GraphRunId;
  /** Run id of the parent execution, for nested loop bodies. */
  parentRunId?: GraphRunId;
  /** Canonical workflow id. */
  workflowId: string;
  /** Dotted path from the workflow root. */
  path?: string[];
  /** The owning execution engine. */
  engine: GraphExecutionEngine;
  /** The facade's code sandbox evaluator, when configured. */
  codeSandboxEvaluator?: CodeSandboxEvaluator;
}

/**
 * Facade-owned {@link GraphExecutionEventSink} implementation. Enriches each
 * partial event with the run's identity, a factory-assigned id/sequence/
 * timestamp, appends it to the bound frame (when present), and dispatches it to
 * all observers. Validation events emitted before the frame is bound are dispatched
 * but not recorded, matching the reference engine's behaviour.
 */
export class GraphEngineEventSink implements GraphFrameAwareEventSink {
  private _frame?: GraphExecutionFrame;

  /**
   * @param emitter - The engine's observer emitter.
   * @param eventFactory - The facade's single event factory (sequencing authority).
   * @param options - Run identity, owner, and evaluator defaults.
   */
  constructor(
    private readonly emitter: GraphExecutionEventEmitter,
    readonly eventFactory: GraphExecutionEventFactory,
    private readonly options: GraphEngineEventSinkOptions
  ) {}

  /** The owning execution engine. */
  get engine(): GraphExecutionEngine {
    return this.options.engine;
  }

  /** The facade's code sandbox evaluator, when configured. */
  get codeSandboxEvaluator(): CodeSandboxEvaluator | undefined {
    return this.options.codeSandboxEvaluator;
  }

  /** The run frame, once bound by the facade. */
  get frame(): GraphExecutionFrame | undefined {
    return this._frame;
  }

  /** Binds the run frame after planning; subsequent events are recorded. */
  bindFrame(frame: GraphExecutionFrame): void {
    this._frame = frame;
  }

  /** Enriches, records (when bound), and dispatches a partial event. */
  async emit(event: Partial<GraphExecutionEvent>): Promise<void> {
    const built = this.eventFactory.create({
      id: "",
      sequence: 0,
      timestamp: new Date(),
      runId: this.options.runId,
      parentRunId: this.options.parentRunId,
      workflowId: this.options.workflowId,
      type: GraphExecutionEventType.NODE_OUTPUT,
      path: this.options.path ?? [],
      ...event,
    } as Omit<GraphExecutionEvent, "id" | "sequence" | "timestamp">);
    this._frame?.appendEvent(built);
    await this.emitter.updateObservers(built);
  }

  /** Dispatches an already-built event to all observers. */
  async updateObservers(event: GraphExecutionEvent): Promise<void> {
    await this.emitter.updateObservers(event);
  }
}

/**
 * Resolves a backend's effective capability metadata, falling back to what its
 * declared `codeMode` and optional catalogue methods imply. A declared
 * `capabilities` object always wins, so a backend can explicitly mark an
 * operation `not_supported` even when it exposes a method, and an omitted
 * capability never degrades to a silently empty result.
 *
 * @param backend - The backend to inspect.
 * @returns The effective engine-agnostic capability metadata.
 */
export function resolveGraphBackendCapabilities(
  backend: GraphExecutionBackend
): GraphBackendCapabilities {
  const declared = backend.capabilities;
  return {
    codeMode: declared?.codeMode ?? backend.codeMode,
    workflows: {
      list:
        declared?.workflows?.list ??
        (typeof backend.listWorkflows === "function"
          ? "supported"
          : "not_supported"),
      get:
        declared?.workflows?.get ??
        (typeof backend.getWorkflow === "function"
          ? "supported"
          : "not_supported"),
    },
  };
}
