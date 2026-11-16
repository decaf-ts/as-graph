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
import { Context, type MaybeContextualArg } from "@decaf-ts/core";
import { graphAuthDataOf, type GraphAuthData } from "../auth";
import {
  GraphExecutionEventType,
  isGraphJsonSafeValue,
  isGraphWorkflowDocumentShape,
  type GraphJsonValue,
  type GraphWorkflowDocument,
} from "../../shared/graph";
import { GraphExecutionEngine } from "../execution/GraphExecutionEngine";
import type {
  GraphExecutionBackend,
  GraphResumeAudit,
  GraphResumeRequest,
} from "../execution/GraphExecutionBackend";
import { GraphExecutionError } from "../errors/GraphExecutionError";
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
  type GraphRunPruneQuery,
  type GraphRunRetentionOptions,
  type GraphRunStore,
} from "./types";
import {
  assertGraphResourceOwnership,
  assertGraphResourceWriteOwnership,
  canAccessGraphResource,
} from "./ownership";
import type { GraphRunModel } from "../../shared/graph";
import { GraphRunEventPublisher } from "./GraphRunEventPublisher";
import { graphRunTimeOf } from "./GraphRunConverters";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { InlineGraphRunQueue, type GraphRunQueue } from "./queue/GraphRunQueue";
import { InProcessGraphRunBus, type GraphRunBus } from "./bus/GraphRunBus";
import {
  InMemoryGraphRunDataStore,
  graphRunResultExpanded,
  type GraphRunDataStore,
} from "./GraphRunDataStore";
import type { GraphRunQuotaResolver } from "./GraphRunQuotas";
import { graphMetrics, withGraphSpan } from "../telemetry/GraphTelemetry";
import type { GraphExecutionErrorPayload } from "../../shared/graph";
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
  /**
   * Run retention: prune finished runs by age and count, with their events
   * and the files only they hold. Unset: runs are kept.
   */
  retention?: GraphRunRetentionOptions;
  /** Where created runs wait for a worker (default: inline, this process). */
  queue?: GraphRunQueue;
  /** Cross-process event/control bus (default: in-process). */
  bus?: GraphRunBus;
  /** `all` (default) enqueues and executes; `api` only enqueues; `worker` only executes. */
  role?: "all" | "api" | "worker";
  /** This process's worker id (default `hostname:pid:uuid`). */
  workerId?: string;
  /** Where finished runs' full results (and run requests) live (default: in memory). */
  runData?: GraphRunDataStore;
  /** Worker heartbeat period (default 10 s). */
  heartbeatMs?: number;
  /** A run whose worker has not beaten for this long is orphaned (default 60 s). */
  leaseMs?: number;
  /** Orphan recovery period (default 30 s; `0` disables it). */
  recoveryIntervalMs?: number;
  /** Runs waiting in the queue above which creation is rejected (429). */
  maxQueueDepth?: number;
  /** Per-tenant quotas (default: none). */
  quotas?: GraphRunQuotaResolver;
  /** How long an idempotency key is honoured (default 24 h). */
  idempotencyTtlMs?: number;
}

/** Default worker heartbeat period. */
export const DEFAULT_GRAPH_RUN_HEARTBEAT_MS = 10_000;
/** Default worker lease (no beat for this long = orphaned). */
export const DEFAULT_GRAPH_RUN_LEASE_MS = 60_000;
/** Default orphan recovery period. */
export const DEFAULT_GRAPH_RUN_RECOVERY_INTERVAL_MS = 30_000;
/** Default idempotency window. */
export const DEFAULT_GRAPH_RUN_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Runs pruned per batch. */
const PRUNE_BATCH = 500;
/** Upper bound on prune batches per pass. */
const MAX_PRUNE_ROUNDS = 1000;

/** Default period of the retention timer: one hour. */
export const DEFAULT_GRAPH_RUN_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

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
    this.runData = options.runData ?? new InMemoryGraphRunDataStore();
    this.queue = options.queue ?? new InlineGraphRunQueue();
    this.bus = options.bus ?? new InProcessGraphRunBus();
    this.workerId = options.workerId ?? `${hostname()}:${process.pid}:${randomUUID()}`;
    this.executor = new GraphRunExecutor(
      engine,
      runStore,
      this.publisher,
      {
        runData: this.runData,
        onRunCompleted: async (run, result) => {
          await options.onRunCompleted?.(run, result);
          // Every finished run is a chance to enforce retention.
          if (this.options.retention) void this.pruneRuns().catch(() => {});
        },
      },
      options.limits
    );
    this.options = {
      ...options,
      limits: { ...DEFAULT_GRAPH_RUN_LIMITS, ...options.limits },
    };
    const intervalMs =
      options.retention?.intervalMs ?? DEFAULT_GRAPH_RUN_PRUNE_INTERVAL_MS;
    if (options.retention && intervalMs > 0) {
      this.pruneTimer = setInterval(() => {
        void this.pruneRuns().catch(() => {});
      }, intervalMs);
      this.pruneTimer.unref?.();
    }
    const pinSweepMs =
      options.retention?.pinSweepIntervalMs ?? DEFAULT_GRAPH_RUN_PRUNE_INTERVAL_MS;
    if (options.retention && pinSweepMs > 0) {
      this.pinSweepTimer = setInterval(() => {
        void this.engine.sweepExpiredPins().catch(() => {});
      }, pinSweepMs);
      this.pinSweepTimer.unref?.();
    }
  }

  /** Periodic expired-pin sweep, when retention is configured. */
  private pinSweepTimer?: ReturnType<typeof setInterval>;

  /** Periodic retention timer, when retention is configured. */
  private pruneTimer?: ReturnType<typeof setInterval>;
  /** Periodic orphan recovery timer. */
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private readonly runData: GraphRunDataStore;
  private readonly queue: GraphRunQueue;
  private readonly bus: GraphRunBus;
  /** This process's worker id. */
  readonly workerId: string;
  private starting?: Promise<void>;
  /** Runs this process is executing. */
  private readonly executing = new Set<string>();
  private stopControl?: () => void;
  private stopping = false;

  /** The run queue (for readiness and depth). */
  get runQueue(): GraphRunQueue {
    return this.queue;
  }

  /** The run bus (for readiness). */
  get runBus(): GraphRunBus {
    return this.bus;
  }

  /** The run data store. */
  get runDataStore(): GraphRunDataStore {
    return this.runData;
  }

  /**
   * Starts the queue (claiming runs unless the role is `api`), listens to
   * control messages and starts orphan recovery. Idempotent; `createRun`
   * starts the service on first use.
   */
  start(): Promise<void> {
    this.starting ??= (async () => {
      const role = this.options.role ?? "all";
      await this.queue.start(
        role === "api" ? undefined : (runId) => this.executeQueuedRun(runId)
      );
      this.stopControl = await this.bus.onControl((message) => {
        if (message.type === "cancel") this.executor.abort(message.runId, "user");
      });
      const every =
        this.options.recoveryIntervalMs ?? DEFAULT_GRAPH_RUN_RECOVERY_INTERVAL_MS;
      if (every > 0 && role !== "api") {
        void this.recoverOrphanedRuns().catch(() => undefined);
        this.recoveryTimer = setInterval(() => {
          void this.recoverOrphanedRuns().catch(() => undefined);
        }, every);
        this.recoveryTimer.unref?.();
      }
    })();
    return this.starting;
  }

  /**
   * Executes one queued run in this process (the queue's worker): loads the
   * run and its request, beats while it executes, and returns once it is
   * finished or suspended. A run already finished or cancelled is skipped.
   */
  async executeQueuedRun(runId: string): Promise<void> {
    const run = await this.runStore.readRun(runId);
    if (!run || run.status !== "queued") return;
    const data = await this.runData.load(runId);
    const request = data?.request;
    const provider = this.documentProviderFor(
      request?.document
        ? { workflow: request.document }
        : { workflowId: request?.workflowId ?? run.workflowId },
      run.ownerUser
    );
    const createdMs = graphRunTimeOf(run.createdAt);
    if (Number.isFinite(createdMs)) {
      graphMetrics.queueWait.record((Date.now() - createdMs) / 1000);
    }
    run.workerId = this.workerId;
    run.attempt = (run.attempt ?? 0) + 1;
    run.heartbeatAt = new Date().toISOString();
    this.executor.begin(runId);
    this.executor.setAuth(runId, request?.auth as GraphAuthData | undefined);
    this.executing.add(runId);
    const beat = setInterval(() => {
      void this.runStore
        .heartbeat?.(runId, this.workerId, new Date())
        .catch(() => undefined);
    }, this.options.heartbeatMs ?? DEFAULT_GRAPH_RUN_HEARTBEAT_MS);
    beat.unref?.();
    graphMetrics.activeRuns.add(1);
    try {
      await withGraphSpan(
        "graph.run",
        { "graph.run.id": runId, "graph.workflow.id": run.workflowId },
        () => this.executor.schedule(run, provider, request?.inputs ?? {})
      );
    } finally {
      clearInterval(beat);
      graphMetrics.activeRuns.add(-1);
      this.executing.delete(runId);
      this.finishActiveRun(runId);
    }
  }

  /**
   * Fails runs whose worker stopped beating (crashed process, lost lease):
   * not finished, not waiting for external input, last beat older than the
   * lease. Queued runs count only when the queue is not durable (an inline
   * queue loses them with the process). Each gets `GRAPH_RUN_ORPHANED` and a
   * terminal event continuing its stored sequence; its files and data stay
   * until retention prunes it.
   *
   * @param now - The reference time.
   * @returns The ids of the runs failed.
   */
  async recoverOrphanedRuns(now: Date = new Date()): Promise<string[]> {
    if (!this.runStore.listStaleRuns) return [];
    const leaseMs = this.options.leaseMs ?? DEFAULT_GRAPH_RUN_LEASE_MS;
    const stale = await this.runStore.listStaleRuns({
      before: new Date(now.getTime() - leaseMs),
      includeQueued: !this.queue.durable,
    });
    const recovered: string[] = [];
    for (const run of stale) {
      if (this.executor.waitFor(run.runId)) continue;
      const error: GraphExecutionErrorPayload = {
        name: "GraphRunOrphanedError",
        message: `Graph run '${run.runId}' lost its worker${run.workerId ? ` (${run.workerId})` : ""} and was failed by recovery`,
        code: "GRAPH_RUN_ORPHANED",
      };
      const sequence = (await this.eventStore.lastSequence?.(run.runId)) ?? 0;
      this.publisher.resumeFrom(run.runId, sequence);
      await this.publisher
        .publish({
          runId: run.runId,
          workflowId: run.workflowId,
          type: GraphExecutionEventType.WORKFLOW_FAILED,
          error,
        })
        .catch(() => undefined);
      this.publisher.release(run.runId);
      await this.runStore.saveRun({
        ...run,
        status: "failed",
        error,
        finishedAt: now.toISOString(),
      });
      graphMetrics.runsFinished.add(1, { status: "failed" });
      recovered.push(run.runId);
    }
    return recovered;
  }

  /**
   * Graceful shutdown: stops claiming runs, waits up to `graceMs` for the
   * runs this process executes, then interrupts the rest
   * (`GRAPH_RUN_INTERRUPTED`), and closes the bus.
   */
  async shutdown(graceMs = Number(process.env["GRAPH_SHUTDOWN_GRACE_MS"] ?? 30_000)): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.dispose();
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.queue.stop().catch(() => undefined);
    const inFlight = [...this.executing]
      .map((runId) => this.executor.waitFor(runId))
      .filter((completion): completion is Promise<GraphRun> => completion !== undefined);
    const drained = Promise.allSettled(inFlight);
    const deadline = new Promise((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      timer.unref?.();
    });
    await Promise.race([drained, deadline]);
    for (const runId of [...this.executing]) {
      this.executor.abort(runId, "shutdown");
    }
    await Promise.race([
      drained,
      new Promise((resolve) => setTimeout(resolve, 5_000).unref?.()),
    ]);
    this.stopControl?.();
    await this.bus.close().catch(() => undefined);
  }
  /** The prune in progress; concurrent requests share it. */
  private pruning?: Promise<string[]>;

  /**
   * Applies run retention now: deletes the finished runs older than
   * `retention.maxAgeMs` and those beyond the newest `retention.maxCount`,
   * each with its events and the files no other run or pin holds. Runs still
   * queued or running are never touched. Concurrent calls share one prune.
   *
   * @param now - The reference time (defaults to the current time).
   * @returns The ids of the pruned runs.
   */
  pruneRuns(now: Date = new Date()): Promise<string[]> {
    if (!this.pruning) {
      this.pruning = this.prune(now).finally(() => {
        this.pruning = undefined;
      });
    }
    return this.pruning;
  }

  private async prune(now: Date): Promise<string[]> {
    const retention = this.options.retention;
    const store = this.runStore;
    if (!retention || !store.listPrunableRuns || !store.deleteRun) return [];
    const pruned: string[] = [];
    const drain = async (query: Omit<GraphRunPruneQuery, "limit">) => {
      // Batches until nothing matches; the bound guards against a store that
      // keeps returning rows it cannot delete.
      for (let round = 0; round < MAX_PRUNE_ROUNDS; round++) {
        const batch = await store.listPrunableRuns!({ ...query, limit: PRUNE_BATCH });
        const victims = batch.filter((entry) => !this.executing.has(entry.runId));
        for (const { runId } of victims) {
          await this.purgeRun(runId);
          pruned.push(runId);
          graphMetrics.runsPruned.add(1);
        }
        if (batch.length < PRUNE_BATCH || victims.length === 0) return;
      }
    };
    if (retention.maxAgeMs !== undefined) {
      await drain({ before: new Date(now.getTime() - retention.maxAgeMs) });
    }
    if (retention.maxCount !== undefined) {
      await drain({ keepNewest: retention.maxCount });
    }
    // Files released by the pruned runs (and earlier releases) are deleted
    // once their grace period has passed.
    await this.engine.binaryStore?.sweep?.(now);
    return pruned;
  }

  /**
   * Removes a finished run: its events, the files no other run or pin holds,
   * and finally the run row (last, so a failure part-way is retried).
   */
  private async purgeRun(
    runId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    this.releaseRunState(runId);
    await this.eventStore.release?.(runId);
    await this.engine.binaryStore?.deleteRun(runId);
    await this.runData.delete(runId);
    await this.runStore.deleteRun?.(runId, ...args);
  }

  /**
   * Deletes a finished run on request (n8n's "delete execution"): the run,
   * its events and the files only it holds. A run still queued or running
   * must be cancelled first.
   *
   * @param runId - The run to delete.
   * @param ownerUser - The caller; must own the run (write ownership).
   * @returns The deleted run as it was.
   * @throws NotFoundError when the run does not exist.
   * @throws GraphExecutionError `GRAPH_RUN_DELETE_ACTIVE` for an unfinished
   * run, `GRAPH_RUN_DELETE_UNSUPPORTED` when the run store cannot delete.
   */
  async deleteRun(
    runId: string,
    ownerUser: string | null,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun> {
    const run = await this.runStore.readRun(runId, ...args);
    if (!run) {
      throw new NotFoundError(`No graph run found for runId '${runId}'`);
    }
    this.assertWriteOwnership(run, ownerUser);
    if (!isGraphRunTerminalStatus(run.status)) {
      throw new GraphExecutionError(
        `Graph run '${runId}' is ${run.status}; cancel it before deleting it`,
        "GRAPH_RUN_DELETE_ACTIVE",
        { runId, status: run.status }
      );
    }
    if (!this.runStore.deleteRun) {
      throw new GraphExecutionError(
        "The configured run store cannot delete runs",
        "GRAPH_RUN_DELETE_UNSUPPORTED",
        { runId }
      );
    }
    await this.purgeRun(runId, ...args);
    return run;
  }

  /** Stops the retention timer (for hosts shutting the service down). */
  dispose(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    if (this.pinSweepTimer) clearInterval(this.pinSweepTimer);
    this.pinSweepTimer = undefined;
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
    if (this.stopping) {
      throw new GraphExecutionError(
        "The graph backend is shutting down",
        "GRAPH_RUN_SHUTTING_DOWN"
      );
    }
    await this.start();

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
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          workflowId: request.workflowId,
          workflow: request.workflow,
          inputs: request.inputs ?? {},
        })
      )
      .digest("hex");
    const idempotencyKey = request.idempotencyKey
      ? `${ownerUser ?? callerKey}:${request.idempotencyKey}`
      : undefined;
    if (idempotencyKey && this.runStore.findByIdempotencyKey) {
      const existing = await this.runStore.findByIdempotencyKey(idempotencyKey, ...args);
      const ttl = this.options.idempotencyTtlMs ?? DEFAULT_GRAPH_RUN_IDEMPOTENCY_TTL_MS;
      if (existing && Date.now() - graphRunTimeOf(existing.createdAt) < ttl) {
        if (existing.requestHash !== requestHash) {
          throw new GraphExecutionError(
            "The Idempotency-Key was already used with a different request",
            "GRAPH_RUN_IDEMPOTENCY_CONFLICT",
            { runId: existing.runId }
          );
        }
        return existing;
      }
    }

    await this.assertAdmission(callerKey, ...args);

    const runId = this.generateRunId();
    const run: GraphRun = {
      runId,
      workflowId,
      ownerUser,
      status: "queued",
      createdAt: new Date().toISOString(),
      callerKey,
      attempt: 0,
      requestHash,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };

    // The request — and the caller's principal — travel with the run, so a
    // worker in any process runs it as the caller.
    const ctx = args.find((arg) => arg instanceof Context) as Context | undefined;
    const auth = graphAuthDataOf(ctx);
    await this.runData.save(runId, {
      request: {
        ...(request.workflow ? { document: request.workflow } : {}),
        workflowId,
        inputs: request.inputs ?? {},
        ...(Object.keys(auth ?? {}).length > 0
          ? { auth: JSON.parse(JSON.stringify(auth)) as Record<string, unknown> }
          : {}),
      },
    });
    await this.runStore.saveRun({ ...run }, ...args);
    if (!this.queue.durable) {
      // Executed in this process: track it for the per-caller fallback count.
      const activeForCaller = this.activeByCaller.get(callerKey) ?? new Set<string>();
      activeForCaller.add(runId);
      this.activeByCaller.set(callerKey, activeForCaller);
      this.callerKeysByRun.set(runId, callerKey);
    }
    graphMetrics.runsStarted.add(1);
    try {
      await this.queue.enqueue(runId);
    } catch (e: unknown) {
      this.finishActiveRun(runId);
      throw e;
    }
    return run;
  }

  /**
   * Admission control for a new run: per-caller concurrency, the tenant's
   * quotas and queue backpressure. Rejections count in
   * `graph_runs_rejected_total` and map to HTTP 429 (403 for storage).
   */
  private async assertAdmission(
    callerKey: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    const reject = (code: string, message: string, reason: string, details = {}) => {
      graphMetrics.runsRejected.add(1, { reason });
      return new GraphExecutionError(message, code, { callerKey, ...details });
    };
    const active = this.runStore.countActiveRuns
      ? await this.runStore.countActiveRuns(callerKey, ...args)
      : (this.activeByCaller.get(callerKey)?.size ?? 0);
    if (active >= this.options.limits.maxConcurrentRuns) {
      throw reject(
        "GRAPH_RUN_CONCURRENCY_LIMIT",
        `Graph run rejected: the configured limit of ${this.options.limits.maxConcurrentRuns} concurrent runs per caller is exhausted`,
        "concurrency"
      );
    }
    const quota = await this.options.quotas?.resolve(callerKey);
    if (quota?.maxActiveRuns !== undefined && active >= quota.maxActiveRuns) {
      throw reject(
        "GRAPH_QUOTA_EXCEEDED",
        `Graph run rejected: the tenant quota of ${quota.maxActiveRuns} active runs is reached`,
        "quota-active",
        { quota: "maxActiveRuns" }
      );
    }
    if (quota?.maxRunsPerMinute !== undefined && this.runStore.countRunsSince) {
      const recent = await this.runStore.countRunsSince(
        callerKey,
        new Date(Date.now() - 60_000),
        ...args
      );
      if (recent >= quota.maxRunsPerMinute) {
        throw reject(
          "GRAPH_QUOTA_EXCEEDED",
          `Graph run rejected: the tenant quota of ${quota.maxRunsPerMinute} runs per minute is reached`,
          "quota-rate",
          { quota: "maxRunsPerMinute" }
        );
      }
    }
    if (quota?.maxStoredBytes !== undefined && this.runStore.sumStoredBytes) {
      const stored = await this.runStore.sumStoredBytes(callerKey, ...args);
      if (stored >= quota.maxStoredBytes) {
        throw reject(
          "GRAPH_QUOTA_STORAGE_EXCEEDED",
          `Graph run rejected: the tenant's runs store ${stored} bytes, above the quota of ${quota.maxStoredBytes}`,
          "quota-storage",
          { quota: "maxStoredBytes", stored }
        );
      }
    }
    if (this.options.maxQueueDepth !== undefined) {
      const depth = await this.queue.depth();
      if (depth >= this.options.maxQueueDepth) {
        throw reject(
          "GRAPH_RUN_QUEUE_FULL",
          `Graph run rejected: ${depth} runs are waiting for a worker (limit ${this.options.maxQueueDepth})`,
          "backpressure",
          { depth }
        );
      }
    }
  }

  /** Reads a run, asserting it belongs to `ownerUser`. */
  /**
   * Reads a run row without ownership checks or result expansion (internal
   * use: readiness probes, recovery).
   */
  getRunRecord(runId: string): Promise<GraphRun | null> {
    return this.runStore.readRun(runId);
  }

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
    if (run.result) {
      // The row holds the summary; the full result lives in the run data.
      const data = await this.runData.load(runId).catch(() => undefined);
      run.result = graphRunResultExpanded(run.result, data);
    }
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
        // Rows read from the durable lane have no `updatedAt` (not in its
        // DDL): order them by their latest lifecycle timestamp instead.
        const timeOf = (model: GraphRunModel) => {
          const at = model.updatedAt ?? model.finishedAt ?? model.startedAt ?? model.createdAt;
          return at ? new Date(at as Date).getTime() : NaN;
        };
        const aTime = timeOf(a);
        const bTime = timeOf(b);
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

    // The worker may live in another process: tell every process.
    if (!this.executor.abort(runId, "user")) {
      await this.bus.publishControl({ type: "cancel", runId }).catch(() => undefined);
    }
    run.status = "cancelled";
    run.finishedAt = new Date().toISOString();
    await this.runStore.saveRun({ ...run }, ...args);
    return run;
  }

  /**
   * Resumes a suspended run: resolves the run, asserts strict owner equality on
   * the write path ({@link assertGraphResourceWriteOwnership}, SAA-105 R3), then
   * delegates to the active backend's optional SAA-196 `resume?()` extension and
   * audits the accepted resume through the event publisher (C18). A backend without
   * the extension fails closed rather than silently no-op.
   *
   * C14: resume is exposed only through this service, behind the owner-equality
   * write gate — never from an HTTP route. The standing SAA-200 hardening rule
   * holds here too: a {@link GraphExecutionError} thrown by the backend is
   * re-thrown without its `details` so no server-side state leaks to clients.
   *
   * @throws NotFoundError when no run exists for `runId`.
   * @throws ForbiddenError when the caller is not the run's recorded owner.
   * @throws GraphExecutionError when the active backend does not support resume
   *   or the backend rejects the resume.
   */
  async resumeRun(
    runId: string,
    request: GraphResumeRequest,
    ownerUser: string | null,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphResumeAudit> {
    const run = await this.runStore.readRun(runId, ...args);
    if (!run) {
      throw new NotFoundError(`No graph run found for runId '${runId}'`);
    }
    this.assertWriteOwnership(run, ownerUser);

    const backend: GraphExecutionBackend = this.engine.backend;
    const resume = backend.resume;
    if (typeof resume !== "function") {
      throw new GraphExecutionError(
        `Graph execution backend '${
          backend.constructor?.name ?? "GraphExecutionBackend"
        }' does not support resume`,
        "GRAPH_RESUME_UNSUPPORTED_BACKEND",
        { runId }
      );
    }

    let audit: GraphResumeAudit;
    try {
      audit = await resume.call(backend, runId, request, ...args);
    } catch (e: unknown) {
      throw sanitizeResumeError(e);
    }

    if (run.suspendedAt) {
      // No longer waiting for input: liveness applies again.
      await this.runStore.saveRun({ ...run, suspendedAt: undefined }, ...args);
    }
    const record: GraphResumeAudit = {
      ...audit,
      runId,
      caller: ownerUser,
    };
    await this.publisher.publish({
      runId,
      workflowId: run.workflowId,
      type: GraphExecutionEventType.WORKFLOW_RESUMED,
      payload: record as unknown as GraphJsonValue,
    });
    return record;
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
    const unsubscribe = this.eventStore.subscribe(runId, listener);
    graphMetrics.sseSubscribers.add(1);
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      graphMetrics.sseSubscribers.add(-1);
      unsubscribe();
    };
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
    if (completion) {
      await completion;
      return this.getRun(runId, ownerUser, ...args);
    }
    // Executed by another process: poll the run row until it settles.
    const deadline = Date.now() + this.options.limits.executionTimeoutMs + 30_000;
    while (Date.now() < deadline) {
      const run = await this.runStore.readRun(runId, ...args);
      if (!run) break;
      if (isGraphRunTerminalStatus(run.status) || run.suspendedAt) break;
      const local = this.executor.waitFor(runId);
      if (local) {
        await local;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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
    this.releaseRunState(runId);
    void Promise.resolve(this.eventStore.release?.(runId)).catch(() => {});
  }

  /** Drops the in-process bookkeeping of a run, leaving its stored events. */
  private releaseRunState(runId: string): void {
    this.finishActiveRun(runId);
    const pending = this.releaseTimers.get(runId);
    if (pending) {
      clearTimeout(pending);
      this.releaseTimers.delete(runId);
    }
    this.executor.release(runId);
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

/**
 * Strips server-side `details` from a resume failure (SAA-200 standing hardening
 * rule): a {@link GraphExecutionError} is re-created from its message and graph
 * code only, so no internal state leaks to clients. Any other error passes through
 * unchanged.
 */
function sanitizeResumeError(error: unknown): unknown {
  if (error instanceof GraphExecutionError) {
    return new GraphExecutionError(error.message, error.graphCode);
  }
  return error;
}
