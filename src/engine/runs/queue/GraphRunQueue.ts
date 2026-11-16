/**
 * @module as-graph/engine/runs/queue/GraphRunQueue
 * @summary Where created runs wait for a worker, and who executes them.
 * @description `POST /graph/runs` saves a `queued` run and enqueues its id;
 * a worker claims the id and executes the run. The queue is swappable
 * (`GRAPH_RUN_QUEUE`); when it is unset the default is `bullmq` (the most
 * performant durable variant per `npm run bench:run-queues`) whenever a
 * Redis/Dragonfly URL is configured, falling back to `inline` otherwise:
 *
 * - `bullmq` (default with a queue URL) — BullMQ jobs on Redis/Dragonfly;
 * - `inline` (fallback) — {@link InlineGraphRunQueue}, the API process
 *   executes the run itself, at once (single-process deployments, tests);
 * - `task-engine` — Decaf core `TaskEngine` tasks persisted through the
 *   configured adapter (Postgres, or Redis/Dragonfly).
 *
 * Runs are never retried by the queue (workflows are not idempotent): a run
 * whose worker dies is failed by orphan recovery
 * (`GraphRunService.recoverOrphanedRuns`).
 */

/** Executes one queued run by id; resolves when the run is finished or suspended. */
export type GraphRunWorker = (runId: string) => Promise<void>;

/** A queue of run ids waiting for a worker. */
export interface GraphRunQueue {
  /** Implementation name (`inline`, `task-engine`, `bullmq`). */
  readonly kind: string;
  /**
   * Whether queued runs survive the process that enqueued them (orphan
   * recovery then leaves `queued` runs alone).
   */
  readonly durable: boolean;
  /**
   * Starts the queue. With a worker, this process claims and executes runs;
   * without one (an `api`-only process) it only enqueues.
   */
  start(worker?: GraphRunWorker): Promise<void>;
  /** Enqueues a run id. */
  enqueue(runId: string): Promise<void>;
  /** Runs waiting for a worker (backpressure). */
  depth(): Promise<number>;
  /** Liveness of the queue's backing service (readiness probe). */
  ping(): Promise<boolean>;
  /** Stops claiming new runs; in-flight runs are left to the caller to drain. */
  stop(): Promise<void>;
}

/** Executes every enqueued run immediately in this process. */
export class InlineGraphRunQueue implements GraphRunQueue {
  readonly kind = "inline";
  readonly durable = false;
  private worker?: GraphRunWorker;
  private stopped = false;
  private pending = 0;

  async start(worker?: GraphRunWorker): Promise<void> {
    this.worker = worker;
    this.stopped = false;
  }

  async enqueue(runId: string): Promise<void> {
    if (!this.worker || this.stopped) {
      throw new Error("The inline run queue has no running worker");
    }
    this.pending++;
    void this.worker(runId)
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
      });
  }

  async depth(): Promise<number> {
    return 0;
  }

  /** Runs this process is executing. */
  get inFlight(): number {
    return this.pending;
  }

  async ping(): Promise<boolean> {
    return !this.stopped;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
