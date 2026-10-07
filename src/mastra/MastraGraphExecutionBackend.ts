/**
 * @module as-graph/mastra/MastraGraphExecutionBackend
 * @summary `@mastra/core`-translated graph execution backend (SAA-196).
 * @description The Mastra analogue of the backend seam: translates the canonical
 * document into a Mastra workflow, runs it through the injected Mastra runtime,
 * bridges the run's `fullStream` onto the facade event sink, and enforces the
 * SAA-193 resume guard conditions for suspended runs. The backend registers
 * itself under the `mastra` flavour on construction and never probes remote
 * engines.
 */
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
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
import { assertMastraResumeAllowed } from "./MastraResumeGuard";
import { assertMastraResumeSchemaSafe } from "./MastraSchemaConverter";
import {
  resolveMastraCapabilities,
  type MastraBackendCapabilities,
} from "./MastraCapabilities";
import {
  GRAPH_MASTRA_AGENT_UNAVAILABLE,
  GRAPH_MASTRA_UNSUPPORTED_KIND,
  MASTRA_BACKEND_FLAVOUR,
  type MastraBackendConfig,
  type MastraNodeStepHandler,
  type MastraResumeAudit,
  type MastraResumeRequest,
  type MastraSuspendStateReader,
} from "./types";

const DEFAULT_MAX_RESUME_BYTES = 64 * 1024;

interface MastraRunLike {
  stream(options?: unknown): Promise<{ fullStream?: AsyncIterable<Record<string, unknown>>; result?: Promise<unknown> }>;
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
  private maxResumeBytes = DEFAULT_MAX_RESUME_BYTES;
  private initialized = false;
  private _config?: MastraBackendConfig;

  constructor() {
    GraphExecutionBackendRegistry.register(MASTRA_BACKEND_FLAVOUR, this);
  }

  async initialize(config: MastraBackendConfig): Promise<void> {
    this._config = config;
    this.runtime = config.mastra;
    // Re-initializing rewires the runtime/compiler, so a previously cached
    // management surface must not survive the rebind (C7).
    this.managementManager = undefined;
    this.suspendStateReader = config.suspendStateReader;
    if (typeof config.maxResumeBytes === "number" && config.maxResumeBytes > 0) {
      this.maxResumeBytes = config.maxResumeBytes;
    }
    const stepHandlers: MastraNodeStepHandler[] = Array.isArray(
      config.stepHandlers
    )
      ? [...config.stepHandlers]
      : [];
    this.compiler = new MastraWorkflowCompiler({ stepHandlers });
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

    const workflow = compiled.workflow as MastraWorkflowLike;
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
    try {
      const run = await workflow.createRun({ runId });
      const stream = await run.stream({ inputData: request.inputs });
      if (stream.fullStream) {
        await bridge.attach(stream.fullStream);
      }
      if (typeof run.getResult === "function") {
        await run.getResult();
      } else if (stream.result) {
        await stream.result;
      }
    } catch (error) {
      status = GraphExecutionStatus.FAILED;
      await sink.emit({
        type: GraphExecutionEventType.WORKFLOW_FAILED,
        status,
        error: this.errorPayload(error),
      });
    }

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
    this.initialized = false;
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

  private async loadRun(runId: GraphRunId): Promise<MastraRunLike | undefined> {
    const runtime = this.runtime;
    if (!isRecord(runtime)) return undefined;
    const getRun = runtime["getRun"];
    if (typeof getRun !== "function") return undefined;
    const run = await (getRun as (id: string) => unknown).call(runtime, runId);
    return isRecord(run) ? (run as unknown as MastraRunLike) : undefined;
  }

  private errorPayload(error: unknown): {
    name: string;
    message: string;
    code?: string;
  } {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        ...(typeof (error as unknown as { code?: unknown }).code === "string"
          ? { code: (error as unknown as { code: string }).code }
          : {}),
      };
    }
    return { name: "MastraError", message: String(error) };
  }
}
