/**
 * @module as-graph/engine/runs/queue/TaskEngineGraphRunQueue
 * @summary Run queue on the Decaf core `TaskEngine`.
 * @description Each run is a `graph-run` task (`{ runId }`) persisted through
 * the configured Decaf adapter — the durable Postgres adapter, or the
 * integrations Redis adapter on Dragonfly. Worker processes claim tasks with
 * a lease the engine renews by heartbeat; `maxAttempts` is 1 because a
 * workflow is not idempotent (a worker that dies leaves the run to orphan
 * recovery, which fails it).
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Condition, Repository, type Adapter } from "@decaf-ts/core";
import {
  TaskBuilder,
  TaskEngine,
  TaskEventBus,
  TaskEventModel,
  TaskHandler,
  TaskHandlerRegistry,
  TaskModel,
  TaskService,
  TaskStatus,
  task,
  type TaskContext,
} from "@decaf-ts/core/tasks";
import type { GraphRunQueue, GraphRunWorker } from "./GraphRunQueue";

/** Task classification of a run. */
export const GRAPH_RUN_TASK = "graph-run";

/** The worker the registered task handler delegates to (one per process). */
let activeWorker: GraphRunWorker | undefined;

/** `graph-run` task handler: executes the run through this process's worker. */
@task(GRAPH_RUN_TASK)
export class GraphRunTaskHandler extends TaskHandler<{ runId: string }, void> {
  async run(input: { runId: string }, ctx: TaskContext): Promise<void> {
    if (!activeWorker) throw new Error("No graph run worker in this process");
    // The engine renews the claim while the run executes.
    const beat = setInterval(() => {
      void ctx.heartbeat?.().catch(() => undefined);
    }, 5_000);
    beat.unref?.();
    try {
      await activeWorker(input.runId);
    } finally {
      clearInterval(beat);
    }
  }
}

/** Options of {@link TaskEngineGraphRunQueue}. */
export interface TaskEngineGraphRunQueueOptions {
  /** Adapter the tasks are persisted through. */
  adapter: Adapter<any, any, any, any>;
  /** Runs this process executes at once (default 4). */
  concurrency?: number;
  /** Task claim lease, renewed by heartbeat (default 30 s). */
  leaseMs?: number;
  /** Poll interval while idle (default 500 ms). */
  pollMsIdle?: number;
  /** Worker id (default `hostname:pid:uuid`). */
  workerId?: string;
}

/** {@link GraphRunQueue} on the Decaf core `TaskEngine`. */
export class TaskEngineGraphRunQueue implements GraphRunQueue {
  readonly kind = "task-engine";
  readonly durable = true;
  private readonly service = new TaskService<any>();
  private engine?: TaskEngine<any>;
  private started = false;

  constructor(private readonly options: TaskEngineGraphRunQueueOptions) {}

  private async boot(): Promise<TaskEngine<any>> {
    if (this.engine) return this.engine;
    // Bind the task models to the adapter first (Decaf's lazy flavouring
    // path), as the engine's own repositories expect.
    Repository.forModel(TaskModel, this.options.adapter.alias);
    Repository.forModel(TaskEventModel, this.options.adapter.alias);
    const concurrency = this.options.concurrency ?? 4;
    await this.service.boot({
      adapter: this.options.adapter,
      bus: new TaskEventBus(),
      registry: new TaskHandlerRegistry(),
      workerId:
        this.options.workerId ?? `${hostname()}:${process.pid}:${randomUUID()}`,
      concurrency,
      leaseMs: this.options.leaseMs ?? 30_000,
      pollMsIdle: this.options.pollMsIdle ?? 500,
      pollMsBusy: 100,
      logTailMax: 200,
      streamBufferSize: 5,
      maxLoggingBuffer: 100,
      loggingBufferTruncation: 10,
      gracefulShutdownMsTimeout: 30_000,
    } as never);
    this.engine = this.service.client as TaskEngine<any>;
    return this.engine;
  }

  async start(worker?: GraphRunWorker): Promise<void> {
    const engine = await this.boot();
    if (worker) {
      activeWorker = worker;
      await engine.start();
      this.started = true;
    }
  }

  async enqueue(runId: string): Promise<void> {
    const engine = await this.boot();
    const built = new TaskBuilder()
      .setClassification(GRAPH_RUN_TASK)
      .setInput({ runId })
      .setMaxAttempts(1)
      .build();
    await engine.push(built);
  }

  async depth(): Promise<number> {
    const repo = Repository.forModel(TaskModel, this.options.adapter.alias);
    const pending = (await repo
      .select()
      .where(
        Condition.attr<TaskModel>("classification")
          .eq(GRAPH_RUN_TASK)
          .and(
            Condition.attr<TaskModel>("status").in([
              TaskStatus.PENDING,
              TaskStatus.SCHEDULED,
              TaskStatus.WAITING_RETRY,
            ])
          )
      )
      .execute()) as TaskModel[];
    return pending.length;
  }

  async ping(): Promise<boolean> {
    try {
      await this.depth();
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.started) {
      await this.engine?.stop();
      this.started = false;
    }
    activeWorker = undefined;
  }
}
