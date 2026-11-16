/**
 * @module as-graph/tests/benchmark/runQueues.bench
 * @summary Benchmarks one run-queue variant: submits a batch of runs to an
 * `api` service and measures how the worker service(s) drain it.
 * @description Run through `npm run bench:run-queues`
 * (`scripts/benchmark-run-queues.cjs`), which starts one process per variant
 * (the TaskEngine models are flavoured for one adapter per process) and
 * compares the results. Configuration (environment):
 *
 * - `GRAPH_BENCH_QUEUE` — `inline` | `task-engine-postgres` |
 *   `task-engine-dragonfly` | `bullmq`.
 * - `GRAPH_BENCH_RUNS` (200), `GRAPH_BENCH_WARMUP` (10).
 * - `GRAPH_BENCH_WORKERS` (1) worker services, each with
 *   `GRAPH_BENCH_CONCURRENCY` (4) runs at once.
 * - `GRAPH_BENCH_DELAY_MS` (0): 0 runs a one-node `core.data.set` workflow;
 *   above 0 the workflow waits that long (`core.flow.delay`), simulating I/O.
 * - `GRAPH_BENCH_POLL_MS` (100): the TaskEngine's idle poll interval.
 * - `GRAPH_BENCH_OUT`: where the JSON result is written.
 *
 * What is shared: every variant uses the same in-memory run store, run data
 * and event rows, so the numbers isolate the queue (and, for distributed
 * variants, the Dragonfly bus). The api and worker services are separate
 * services but share this Node process and its event loop. With
 * `GRAPH_BENCH_WORKERS` > 1 the TaskEngine variants claim with every worker's
 * engine but execute every run on the last-started worker service (the
 * `@task` handler is process-wide); `runsPerWorker` shows it.
 */
import { jest, describe, it, expect } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient } from "redis";
import { distributedPair, greetWorkflow } from "../integration/graph/distributedRunHarness";
import type { GraphRunQueue } from "../../src/engine/runs/queue/GraphRunQueue";
import { GRAPH_RUN_FINISHED_STATUSES, type GraphRun } from "../../src/engine/runs/types";
import { document, edge, node, port } from "../../src/workflows/builders";

const env = process.env;
const VARIANT = env["GRAPH_BENCH_QUEUE"] ?? "inline";
const RUNS = Number(env["GRAPH_BENCH_RUNS"] ?? 200);
const WARMUP = Number(env["GRAPH_BENCH_WARMUP"] ?? 10);
const WORKERS = Number(env["GRAPH_BENCH_WORKERS"] ?? 1);
const CONCURRENCY = Number(env["GRAPH_BENCH_CONCURRENCY"] ?? 4);
const DELAY_MS = Number(env["GRAPH_BENCH_DELAY_MS"] ?? 0);
const POLL_MS = Number(env["GRAPH_BENCH_POLL_MS"] ?? 100);
const OUT = env["GRAPH_BENCH_OUT"];
const DRAGONFLY = env["GRAPH_IT_DRAGONFLY_URL"] ?? "";
const POSTGRES = env["GRAPH_IT_POSTGRES_URL"] ?? "";

jest.setTimeout(30 * 60_000);

const delayWorkflow = document({
  id: "bench-delay",
  name: "bench-delay",
  inputs: [port("value")],
  outputs: [port("out")],
  nodes: [node("wait", "core.flow.delay", { timeoutMs: DELAY_MS })],
  edges: [
    edge("e1", ["workflow", "value"], ["node", "wait", "value"]),
    edge("e2", ["node", "wait", "value"], ["workflow", "out"]),
  ],
});

/** Percentile of sorted values (nearest rank). */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / (sorted.length || 1);
  return {
    mean: Math.round(mean * 10) / 10,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

const time = (value: string | undefined) => (value ? Date.parse(value) : Number.NaN);

/** The queue factory and cleanup of a variant. */
async function variantQueue(prefix: string): Promise<{
  makeQueue: () => Promise<GraphRunQueue>;
  cleanup: () => Promise<void>;
}> {
  switch (VARIANT) {
    case "inline":
      return { makeQueue: async () => undefined as never, cleanup: async () => undefined };
    case "task-engine-postgres": {
      if (!POSTGRES) throw new Error("GRAPH_IT_POSTGRES_URL is not set");
      const { createTypeormGraphAdapter } = await import("../../src/typeorm");
      const adapter = await createTypeormGraphAdapter({
        dataSource: {
          type: "postgres",
          url: POSTGRES,
          schema: env["GRAPH_IT_POSTGRES_SCHEMA"] ?? "asgraph",
          synchronize: false,
        },
        includeTaskModels: true,
      });
      const { TaskEngineGraphRunQueue } = await import("../../src/engine/runs/queue/TaskEngineGraphRunQueue");
      const started = new Date();
      return {
        makeQueue: async () =>
          new TaskEngineGraphRunQueue({ adapter: adapter as never, concurrency: CONCURRENCY, pollMsIdle: POLL_MS }),
        cleanup: async () => {
          const client = (adapter as unknown as { client: { query(q: string, v: unknown[]): Promise<unknown> } }).client;
          await client.query(`DELETE FROM "task_event" WHERE "ts" >= $1`, [started]).catch(() => undefined);
          await client.query(`DELETE FROM "tasks" WHERE "createdAt" >= $1`, [started]).catch(() => undefined);
        },
      };
    }
    case "task-engine-dragonfly": {
      if (!DRAGONFLY) throw new Error("GRAPH_IT_DRAGONFLY_URL is not set");
      const { RedisAdapter } = await import("@decaf-ts/integrations/redis");
      const adapter = new (RedisAdapter as unknown as new (conf: unknown, alias: string) => {
        initialize(): Promise<void>;
      })({ url: DRAGONFLY, prefix }, `graph-bench-tasks-${randomUUID()}`);
      await adapter.initialize().catch(() => undefined);
      const { TaskEngineGraphRunQueue } = await import("../../src/engine/runs/queue/TaskEngineGraphRunQueue");
      return {
        makeQueue: async () =>
          new TaskEngineGraphRunQueue({ adapter: adapter as never, concurrency: CONCURRENCY, pollMsIdle: POLL_MS }),
        cleanup: async () => undefined,
      };
    }
    case "bullmq": {
      if (!DRAGONFLY) throw new Error("GRAPH_IT_DRAGONFLY_URL is not set");
      const { BullMqGraphRunQueue } = await import("../../src/engine/runs/queue/BullMqGraphRunQueue");
      return {
        makeQueue: async () =>
          new BullMqGraphRunQueue({ url: DRAGONFLY, prefix, name: "graph-runs-bench", concurrency: CONCURRENCY }),
        cleanup: async () => undefined,
      };
    }
    default:
      throw new Error(`unknown GRAPH_BENCH_QUEUE '${VARIANT}'`);
  }
}

/** Deletes the Dragonfly keys under the benchmark's prefix. */
async function purgeDragonfly(prefix: string): Promise<void> {
  if (!DRAGONFLY) return;
  const client = createClient({ url: DRAGONFLY });
  await client.connect();
  try {
    for await (const keys of client.scanIterator({ MATCH: `*${prefix}*`, COUNT: 500 })) {
      const batch = ([] as string[]).concat(keys as unknown as string[]);
      if (batch.length) await client.del(batch);
    }
  } finally {
    await client.quit();
  }
}

describe(`run queue benchmark: ${VARIANT}`, () => {
  it("drains a batch of runs", async () => {
    const prefix = `{graph-bench-${randomUUID().slice(0, 8)}}`;
    const { makeQueue, cleanup } = await variantQueue(prefix);
    const { api, workers, runStore } = await distributedPair(DRAGONFLY, makeQueue, {
      mode: VARIANT === "inline" ? "inline" : "distributed",
      workers: WORKERS,
      limits: { maxConcurrentRuns: Number.MAX_SAFE_INTEGER },
    });
    const workflow = DELAY_MS > 0 ? delayWorkflow : greetWorkflow;
    const inputs = DELAY_MS > 0 ? { value: 1 } : { name: { who: "bench" } };

    /** Submits `count` runs at once; returns their ids and submit latencies. */
    const submit = async (count: number) => {
      const submitMs: number[] = [];
      const ids = await Promise.all(
        Array.from({ length: count }, async () => {
          const t0 = performance.now();
          const run = await api.createRun({ workflow, inputs }, null);
          submitMs.push(performance.now() - t0);
          return run.runId;
        })
      );
      return { ids, submitMs };
    };
    /** Waits until every run is finished; returns the run records. */
    const drain = async (ids: string[]) => {
      const deadline = Date.now() + Math.max(120_000, RUNS * (DELAY_MS + 200));
      const done = new Map<string, GraphRun>();
      while (done.size < ids.length) {
        if (Date.now() > deadline) throw new Error(`timed out: ${done.size}/${ids.length} runs finished`);
        for (const id of ids) {
          if (done.has(id)) continue;
          const run = (await runStore.readRun(id)) as GraphRun | undefined;
          if (run && (GRAPH_RUN_FINISHED_STATUSES as readonly string[]).includes(run.status)) done.set(id, run);
        }
        if (done.size < ids.length) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return ids.map((id) => done.get(id) as GraphRun);
    };

    try {
      if (WARMUP > 0) await drain((await submit(WARMUP)).ids);

      const wallStart = Date.now();
      const { ids, submitMs } = await submit(RUNS);
      const runs = await drain(ids);
      const wallMs = Date.now() - wallStart;

      const failed = runs.filter((run) => run.status !== "succeeded").length;
      const firstCreated = Math.min(...runs.map((run) => time(run.createdAt)));
      const lastFinished = Math.max(...runs.map((run) => time(run.finishedAt)));
      const perWorker: Record<string, number> = {};
      for (const run of runs) perWorker[run.workerId ?? "?"] = (perWorker[run.workerId ?? "?"] ?? 0) + 1;

      const result = {
        variant: VARIANT,
        config: {
          runs: RUNS,
          warmup: WARMUP,
          workers: VARIANT === "inline" ? 1 : WORKERS,
          concurrency: VARIANT === "inline" ? null : CONCURRENCY,
          delayMs: DELAY_MS,
          pollMs: VARIANT.startsWith("task-engine") ? POLL_MS : null,
        },
        failed,
        wallMs,
        throughputPerSec: Math.round((RUNS / ((lastFinished - firstCreated) / 1000)) * 10) / 10,
        submitMs: stats(submitMs.map((v) => Math.round(v * 10) / 10)),
        queueWaitMs: stats(runs.map((run) => time(run.startedAt) - time(run.createdAt))),
        executionMs: stats(runs.map((run) => time(run.finishedAt) - time(run.startedAt))),
        endToEndMs: stats(runs.map((run) => time(run.finishedAt) - time(run.createdAt))),
        runsPerWorker: Object.values(perWorker),
        at: new Date().toISOString(),
      };
      console.log(`GRAPH_BENCH_RESULT ${JSON.stringify(result)}`);
      if (OUT) {
        await mkdir(dirname(OUT), { recursive: true });
        await writeFile(OUT, JSON.stringify(result, null, 2));
      }
      expect(failed).toBe(0);
    } finally {
      await api.shutdown(1_000);
      for (const worker of workers) if (worker !== api) await worker.shutdown(1_000);
      await cleanup();
      await purgeDragonfly(prefix);
    }
  });
});
