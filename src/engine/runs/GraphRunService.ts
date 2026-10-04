/**
 * @module as-graph/engine/runs/GraphRunService
 * @summary Graph run lifecycle service (DECAF-50 §4.16).
 * @description Creates, tracks, cancels, and observes graph runs on top of a
 * {@link GraphRunStore} and {@link GraphRunEventStore}: per-caller run
 * limits (concurrency buckets keyed by owner or caller key, timeout, event
 * payload size), fail-closed ownership scoping on every read, strict
 * owner-equality on the cancel write path (SAA-105 R3),
 * event-state auto-release after the replay window (SAA-595), and the
 * sequenced event stream the SSE controller replays.
 */
import { NotFoundError, ValidationError } from "@decaf-ts/db-decorators";
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import {
  isGraphJsonSafeValue,
  isGraphWorkflowDocumentShape,
  type GraphWorkflowDocument,
} from "../../shared/graph";
import { GraphExecutionEngine } from "../execution/GraphExecutionEngine";
import { GraphStoreError } from "../errors/GraphStoreError";
import { graphRunDocumentFingerprint } from "./GraphRunFingerprint";
import {
  DEFAULT_GRAPH_RUN_LIMITS,
  isGraphRunTerminalStatus,
  type GraphRunEventEnvelope,
  type GraphRunLimits,
} from "../../shared/graph";
import {
  type GraphRun,
  type GraphRunCreateRequest,
  type GraphRunDocumentResolver,
  type GraphRunEventStore,
  type GraphRunStore,
} from "./types";
import {
  assertGraphResourceOwnership,
  assertGraphResourceWriteOwnership,
  canAccessGraphResource,
} from "./ownership";
import type { GraphRunModel } from "../../shared/graph";
import { GraphRunEventPublisher } from "./GraphRunEventPublisher";
import { GraphRunDocumentProvider, GraphRunExecutor } from "./GraphRunExecutor";

/** Construction options for {@link GraphRunService}. */
export interface GraphRunServiceOptions {
  /** Run limits (timeouts, event payload caps, concurrency); defaults from {@link DEFAULT_GRAPH_RUN_LIMITS}. */
  limits?: GraphRunLimits;
  /** Resolves saved workflow documents for by-`workflowId` run requests. */
  documentResolver?: GraphRunDocumentResolver;
  /** Called once per run when it reaches a terminal state. */
  onRunCompleted?: (
    run: GraphRun,
    result?: GraphRun["result"]
  ) => Promise<void>;
  /**
   * Explicit DECAF-48 §4.15 standalone tolerance: when `true`, anonymous
   * callers (no resolved identity) are tolerated on owned runs. Defaults to
   * `false` — ownership checks fail closed for absent identities (SAA-595).
   */
  allowAnonymousAccess?: boolean;
}

/**
 * Run lifecycle service (DECAF-50 §4.16): creates, tracks, cancels, and
 * observes graph runs on top of a {@link GraphRunStore} and
 * {@link GraphRunEventStore}. Enforces per-caller run limits (concurrency
 * buckets keyed by owner or caller key, timeout, event payload size), scopes
 * every read to the owning user, authorizes cancellation by strict owner
 * equality (SAA-105 R3), auto-releases retained event state
 * after the configured replay window (SAA-595), and exposes the sequenced
 * event stream the SSE controller replays.
 */
export class GraphRunService {
  private readonly engine: GraphExecutionEngine;
  private readonly runStore: GraphRunStore;
  private readonly eventStore: GraphRunEventStore;
  private readonly publisher: GraphRunEventPublisher;
  private readonly executor: GraphRunExecutor;
  private readonly options: GraphRunServiceOptions & {
    limits: Required<GraphRunLimits>;
  };
  private readonly activeByCaller = new Map<string, Set<string>>();
  private readonly callerKeysByRun = new Map<string, string>();
  private readonly releaseTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    engine: GraphExecutionEngine,
    runStore: GraphRunStore,
    eventStore: GraphRunEventStore,
    options: GraphRunServiceOptions = {}
  ) {
    this.engine = engine;
    this.runStore = runStore;
    this.eventStore = eventStore;
    this.publisher = new GraphRunEventPublisher(eventStore, options.limits);
    this.executor = new GraphRunExecutor(
      engine,
      runStore,
      this.publisher,
      { onRunCompleted: options.onRunCompleted },
      options.limits
    );
    this.options = {
      ...options,
      limits: { ...DEFAULT_GRAPH_RUN_LIMITS, ...options.limits },
    };
  }

  /** Effective run limits, with defaults applied. */
  get limits(): Required<GraphRunLimits> {
    return this.options.limits;
  }

  /**
   * Creates and schedules a run for a saved `workflowId` or an inline
   * workflow document, enforcing the per-caller concurrency limit and
   * ownership bookkeeping. Returns the queued run immediately; execution
   * continues in the background.
   *
   * `concurrencyKey` buckets anonymous callers for the per-caller
   * concurrency cap (e.g. a per-IP key from the HTTP layer); it defaults to
   * the owner user, or `"anonymous"` when both are absent.
   *
   * @throws ValidationError when the request carries no workflow identity, a
   * `workflowId` without a configured resolver, or the per-caller concurrency
   * limit is exhausted.
   */
  async createRun(
    request: GraphRunCreateRequest,
    ownerUser: string | null,
    concurrencyKey?: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun> {
    this.validateCreateRequest(request);

    const workflowId = request.workflowId ?? request.workflow?.id ?? "";
    if (!workflowId) {
      throw new ValidationError(
        "Graph run request must carry a workflow document with an id or a saved workflowId"
      );
    }
    if (request.workflowId && !this.options.documentResolver) {
      throw new ValidationError(
        "Graph run requests by workflowId require a document resolver"
      );
    }

    const callerKey = concurrencyKey ?? ownerUser ?? "anonymous";
    const activeForCaller =
      this.activeByCaller.get(callerKey) ?? new Set<string>();
    if (activeForCaller.size >= this.options.limits.maxConcurrentRuns) {
      throw new ValidationError(
        `Graph run rejected: the configured limit of ${this.options.limits.maxConcurrentRuns} concurrent runs per caller is exhausted`
      );
    }

    const runId = this.generateRunId();
    const run: GraphRun = {
      runId,
      workflowId,
      ownerUser,
      status: "queued",
      createdAt: new Date().toISOString(),
    };

    this.executor.begin(runId);
    await this.runStore.saveRun({ ...run }, ...args);

    const provider = this.documentProviderFor(request, ownerUser);
    activeForCaller.add(runId);
    this.activeByCaller.set(callerKey, activeForCaller);
    this.callerKeysByRun.set(runId, callerKey);
    const completion = this.executor.schedule(
      run,
      provider,
      request.inputs ?? {},
      ...args
    );
    void completion
      .catch(() => undefined)
      .finally(() => this.finishActiveRun(runId));

    return run;
  }

  /** Reads a run, asserting it belongs to `ownerUser`. */
  async getRun(
    runId: string,
    ownerUser: string | null,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun> {
    const run = await this.runStore.readRun(runId, ...args);
    if (!run) {
      throw new NotFoundError(`No graph run found for runId '${runId}'`);
    }
    this.assertOwnership(run, ownerUser);
    return run;
  }

  /**
   * Lists the persisted run rows for a workflow document, scoped to the
   * requesting owner and ordered newest first.
   *
   * The collection is ownership-filtered with
   * {@link canAccessGraphResource}: owner-less runs stay visible to everyone,
   * a named caller sees their own plus owner-less runs, and an anonymous caller
   * without the explicit `allowAnonymousAccess` tolerance sees only owner-less
   * runs (SAA-595). The persisted {@link GraphRunModel} rows are returned so
   * the HTTP boundary can serve the frontend-safe listing shape.
   *
   * The newest-first sort is corrupt-date-safe (SAA-93 R2): a row whose
   * `updatedAt` is missing or not a valid `Date` is treated as oldest
   * (epoch `0`) instead of producing `NaN` comparisons that would make the
   * ordering of adjacent rows undefined.
   *
   * @param {string} workflowId - Workflow document id to list runs for.
   * @param {string | null} ownerUser - Identity of the requesting caller.
   * @param args - An optional decaf `Context` forwarded to the store.
   * @return {Promise<GraphRunModel[]>} The workflow's runs, newest first.
   * @throws Re-throws any store failure from {@link GraphRunStore.listRuns}.
   */
  async listRunsByWorkflow(
    workflowId: string,
    ownerUser: string | null,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRunModel[]> {
    const models = await this.runStore.listRuns(workflowId, ...args);
    return models
      .filter((model) =>
        canAccessGraphResource({ owner: model.owner }, ownerUser, {
          allowAnonymousAccess: this.options.allowAnonymousAccess === true,
        })
      )
      .sort((a, b) => {
        const aTime = a.updatedAt instanceof Date ? a.updatedAt.getTime() : NaN;
        const bTime = b.updatedAt instanceof Date ? b.updatedAt.getTime() : NaN;
        return (
          (Number.isFinite(bTime) ? bTime : 0) -
          (Number.isFinite(aTime) ? aTime : 0)
        );
      });
  }

  /**
   * Cancels a non-terminal run: aborts in-flight execution and persists the
   * `cancelled` status. Terminal runs are returned unchanged.
   *
   * Cancellation is a write and is authorized by strict owner equality
   * ({@link assertGraphResourceWriteOwnership}, SAA-105 R3): only the run's
   * recorded owner may cancel it. A named caller can no longer cancel an
   * owner-less run, and the read-visibility tolerance `allowAnonymousAccess`
   * never grants a cancellation.
   */
  async cancelRun(
    runId: string,
    ownerUser: string | null,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun> {
    const run = await this.runStore.readRun(runId, ...args);
    if (!run) {
      throw new NotFoundError(`No graph run found for runId '${runId}'`);
    }
    this.assertWriteOwnership(run, ownerUser);

    if (isGraphRunTerminalStatus(run.status)) {
      return run;
    }

    this.executor.abort(runId, "user");
    run.status = "cancelled";
    run.finishedAt = new Date().toISOString();
    await this.runStore.saveRun({ ...run }, ...args);
    return run;
  }

  /** Lists a run's event envelopes after the given sequence (ownership-checked). */
  async listEvents(
    runId: string,
    afterSequence: number,
    ownerUser: string | null,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRunEventEnvelope[]> {
    await this.getRun(runId, ownerUser, ...args);
    return this.eventStore.listAfter(runId, afterSequence);
  }

  /** Subscribes a live listener to a run's event stream (ownership-checked); returns an unsubscribe function. */
  async subscribeEvents(
    runId: string,
    ownerUser: string | null,
    listener: (event: GraphRunEventEnvelope) => void,
    ...args: MaybeContextualArg<Context>
  ): Promise<() => void> {
    await this.getRun(runId, ownerUser, ...args);
    return this.eventStore.subscribe(runId, listener);
  }

  /** Subscribes a listener to a run's event stream without re-reading the run. */
  subscribeRunEvents(
    run: GraphRun,
    listener: (event: GraphRunEventEnvelope) => void
  ): () => void {
    return this.eventStore.subscribe(run.runId, listener);
  }

  /** Waits for a scheduled run to finish, then returns its final state. */
  async waitForRun(
    runId: string,
    ownerUser: string | null,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun> {
    const completion = this.executor.waitFor(runId);
    if (completion) await completion;
    return this.getRun(runId, ownerUser, ...args);
  }

  /**
   * Convenience helper: creates a run and waits for its completion. The
   * optional `concurrencyKey` is forwarded to {@link createRun} to bucket
   * anonymous callers for the per-caller concurrency cap.
   */
  async executeAndWait(
    request: GraphRunCreateRequest,
    ownerUser: string | null,
    concurrencyKey?: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun> {
    const run = await this.createRun(
      request,
      ownerUser,
      concurrencyKey,
      ...args
    );
    return this.waitForRun(run.runId, ownerUser, ...args);
  }

  /**
   * Releases all per-run bookkeeping for a finished run: caller-bucket
   * membership, executor state, publisher sequencing, retained event state,
   * and any pending auto-release timer.
   */
  release(runId: string): void {
    this.finishActiveRun(runId);
    const pending = this.releaseTimers.get(runId);
    if (pending) {
      clearTimeout(pending);
      this.releaseTimers.delete(runId);
    }
    this.executor.release(runId);
    this.eventStore.release?.(runId);
  }

  /**
   * Removes a run from its caller's concurrency bucket and schedules event
   * state release after the configured replay window.
   */
  private finishActiveRun(runId: string): void {
    const callerKey = this.callerKeysByRun.get(runId);
    if (callerKey !== undefined) {
      this.callerKeysByRun.delete(runId);
      const bucket = this.activeByCaller.get(callerKey);
      if (bucket) {
        bucket.delete(runId);
        if (bucket.size === 0) this.activeByCaller.delete(callerKey);
      }
    }
    if (this.releaseTimers.has(runId)) return;
    const timer = setTimeout(() => {
      this.releaseTimers.delete(runId);
      this.release(runId);
    }, this.options.limits.eventReplayWindowMs);
    timer.unref?.();
    this.releaseTimers.set(runId, timer);
  }

  private validateCreateRequest(request: GraphRunCreateRequest): void {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new ValidationError(
        "Graph run request must be an object carrying either a workflow document or a workflowId plus inputs"
      );
    }
    const hasDocument = request.workflow !== undefined;
    const hasWorkflowId = request.workflowId !== undefined;
    if (hasDocument && hasWorkflowId) {
      throw new ValidationError(
        "Graph run request is ambiguous: supply either an unsaved workflow document or a saved workflowId, not both"
      );
    }
    if (!hasDocument && !hasWorkflowId) {
      throw new ValidationError(
        "Graph run request must supply either an unsaved workflow document or a saved workflowId"
      );
    }
    if (hasDocument && !isGraphWorkflowDocumentShape(request.workflow)) {
      throw new ValidationError(
        "Graph run request carries a payload that is not a canonical GraphWorkflowDocument"
      );
    }
    if (request.inputs !== undefined && !isGraphJsonSafeValue(request.inputs)) {
      throw new ValidationError(
        "Graph run inputs must be JSON-safe: functions, class instances, undefined, NaN/Infinity, symbol keys and unsafe prototype keys (__proto__/prototype/constructor) are rejected"
      );
    }
    const bytes = safeJsonLength(request);
    if (bytes > this.options.limits.maxRequestBytes) {
      throw new ValidationError(
        `Graph run request of ${bytes} bytes exceeds the configured limit of ${this.options.limits.maxRequestBytes} bytes`
      );
    }
  }

  private documentProviderFor(
    request: GraphRunCreateRequest,
    ownerUser: string | null
  ): GraphRunDocumentProvider {
    if (request.workflow) {
      const document = request.workflow;
      return async () => ({
        document,
        fingerprint: graphRunDocumentFingerprint(document),
      });
    }
    const workflowId = request.workflowId as string;
    return async (...args: MaybeContextualArg<Context>) => {
      const resolver = this.options.documentResolver;
      if (!resolver) {
        throw new ValidationError(
          "Graph run requests by workflowId require a document resolver"
        );
      }
      const document: GraphWorkflowDocument = await resolver.resolve(
        workflowId,
        ownerUser,
        ...args
      );
      return {
        document,
        fingerprint: graphRunDocumentFingerprint(document),
      };
    };
  }

  /**
   * Read-visibility check for a run: honours the owner-less visibility contract
   * and the explicit `allowAnonymousAccess` tolerance (SAA-595/SAA-93 F1).
   */
  private assertOwnership(run: GraphRun, ownerUser: string | null): void {
    assertGraphResourceOwnership({ owner: run.ownerUser }, ownerUser, {
      allowAnonymousAccess: this.options.allowAnonymousAccess === true,
      resourceKind: "Graph run",
      resourceId: run.runId,
    });
  }

  /**
   * Write-path check for a run: strict owner equality, never the read tolerance
   * (SAA-105 R3).
   */
  private assertWriteOwnership(run: GraphRun, ownerUser: string | null): void {
    assertGraphResourceWriteOwnership({ owner: run.ownerUser }, ownerUser, {
      resourceKind: "Graph run",
      resourceId: run.runId,
    });
  }

  /**
   * Generates a cryptographically random run id. `crypto.randomUUID` is always
   * available in the backend runtimes as-graph targets; the frontend never
   * creates run ids. If it is somehow unavailable the service fails loudly
   * rather than falling back to a predictable, guessable id.
   *
   * @throws {GraphStoreError} when `crypto.randomUUID` is unavailable.
   */
  private generateRunId(): string {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.randomUUID !== "function") {
      throw new GraphStoreError(
        "Cannot generate a graph run id: crypto.randomUUID is unavailable in this runtime",
        { runtime: typeof globalThis.crypto }
      );
    }
    return cryptoApi.randomUUID();
  }
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
