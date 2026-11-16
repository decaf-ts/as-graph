/**
 * @module as-graph/engine/runs/queue/BullMqGraphRunQueue
 * @summary Run queue on BullMQ (Redis / Dragonfly).
 * @description Each run is a `run` job (`{ runId }`, job id = run id) on the
 * `graph-runs` queue. Workers run with the configured concurrency; jobs are
 * not retried (a workflow is not idempotent) and are removed once done.
 * BullMQ's stalled-job detection plays the lease role; a run whose worker
 * died is failed by orphan recovery. On Dragonfly the queue prefix is a hash
 * tag (`{graph}`), as Dragonfly's BullMQ mode requires
 * (`--cluster_mode=emulated --lock_on_hashtags`).
 */
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { GraphRunQueue, GraphRunWorker } from "./GraphRunQueue";

/** Options of {@link BullMqGraphRunQueue}. */
export interface BullMqGraphRunQueueOptions {
  /** Redis/Dragonfly URL (e.g. `redis://127.0.0.1:6379`). */
  url: string;
  /** Runs this process executes at once (default 4). */
  concurrency?: number;
  /** Queue name (default `graph-runs`). */
  name?: string;
  /** Key prefix (default `{graph}`, a hash tag for Dragonfly). */
  prefix?: string;
  /** Stalled-job lock duration (default 30 s). */
  lockDurationMs?: number;
}

/** Connection options of a Redis URL. */
function connectionOf(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.pathname && parsed.pathname !== "/"
      ? { db: Number(parsed.pathname.slice(1)) }
      : {}),
    maxRetriesPerRequest: null,
  };
}

/** {@link GraphRunQueue} on BullMQ. */
export class BullMqGraphRunQueue implements GraphRunQueue {
  readonly kind = "bullmq";
  readonly durable = true;
  private readonly queue: Queue;
  private worker?: Worker;
  private readonly connection: ConnectionOptions;
  private readonly name: string;
  private readonly prefix: string;

  constructor(private readonly options: BullMqGraphRunQueueOptions) {
    this.connection = connectionOf(options.url);
    this.name = options.name ?? "graph-runs";
    this.prefix = options.prefix ?? "{graph}";
    this.queue = new Queue(this.name, {
      connection: this.connection,
      prefix: this.prefix,
    });
  }

  async start(worker?: GraphRunWorker): Promise<void> {
    if (!worker) return;
    this.worker = new Worker(
      this.name,
      async (job) => {
        await worker((job.data as { runId: string }).runId);
      },
      {
        connection: this.connection,
        prefix: this.prefix,
        concurrency: this.options.concurrency ?? 4,
        lockDuration: this.options.lockDurationMs ?? 30_000,
        maxStalledCount: 0,
      }
    );
    await this.worker.waitUntilReady();
  }

  async enqueue(runId: string): Promise<void> {
    await this.queue.add(
      "run",
      { runId },
      { jobId: runId, attempts: 1, removeOnComplete: true, removeOnFail: true }
    );
  }

  async depth(): Promise<number> {
    const counts = await this.queue.getJobCounts("waiting", "delayed", "prioritized");
    return (counts["waiting"] ?? 0) + (counts["delayed"] ?? 0) + (counts["prioritized"] ?? 0);
  }

  async ping(): Promise<boolean> {
    try {
      await this.queue.getJobCounts("waiting");
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
    await this.queue.close();
  }
}
