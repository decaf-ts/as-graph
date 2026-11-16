/**
 * @module as-graph/nest/graph/GraphRunInfrastructure
 * @summary Run queue, bus, role and limits of the standalone backend, from
 * the environment.
 * @description
 * - `GRAPH_ROLE` — `all` (default: enqueue and execute), `api` (enqueue
 *   only) or `worker` (execute only).
 * - `GRAPH_RUN_QUEUE` — `bullmq` by default (the most performant durable
 *   variant per `npm run bench:run-queues`) when a queue URL is configured
 *   (`GRAPH_QUEUE_REDIS_URL`, else `GRAPH_REDIS_URL`); `inline` (this
 *   process) as the fallback when no Redis/Dragonfly URL is configured, so
 *   single-process boots still work; `task-engine` (Decaf core TaskEngine on
 *   the run adapter — Postgres, or Redis/Dragonfly through
 *   `GRAPH_TASK_ENGINE_REDIS_URL`) stays opt-in.
 * - `GRAPH_BUS` — `in-process` (default) or `redis` (Dragonfly/Redis pub/sub,
 *   `GRAPH_BUS_REDIS_URL`, else `GRAPH_REDIS_URL`).
 * - `GRAPH_WORKER_CONCURRENCY` (4), `GRAPH_RUN_HEARTBEAT_MS` (10000),
 *   `GRAPH_RUN_LEASE_MS` (60000), `GRAPH_RUN_RECOVERY_INTERVAL_MS` (30000),
 *   `GRAPH_QUEUE_MAX_DEPTH` (unset: unlimited), and the
 *   `GRAPH_QUOTA_*` defaults ({@link graphRunQuotaFromEnv}).
 */
import type { Adapter } from "@decaf-ts/core";
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
import type { GraphRunServiceOptions } from "../../engine/runs/GraphRunService";
import { InlineGraphRunQueue, type GraphRunQueue } from "../../engine/runs/queue/GraphRunQueue";
import { InProcessGraphRunBus, type GraphRunBus } from "../../engine/runs/bus/GraphRunBus";
import {
  GraphRunQuotaResolver,
  graphRunQuotaFromEnv,
} from "../../engine/runs/GraphRunQuotas";

/** Reads a non-negative integer from the environment. */
function integer(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new GraphExecutionError(
      `${name} must be a non-negative number; got '${raw}'`,
      "GRAPH_RUN_CONFIG_INVALID",
      { name, value: raw }
    );
  }
  return Math.floor(value);
}

/** The Redis/Dragonfly URL for a component. */
function redisUrl(env: NodeJS.ProcessEnv, specific: string): string {
  const url = env[specific]?.trim() || env["GRAPH_REDIS_URL"]?.trim();
  if (!url) {
    throw new GraphExecutionError(
      `${specific} (or GRAPH_REDIS_URL) must point at Dragonfly/Redis`,
      "GRAPH_RUN_CONFIG_INVALID",
      { name: specific }
    );
  }
  return url;
}

/** The run-queue kinds the resolver accepts. */
export type GraphRunQueueKind = "inline" | "task-engine" | "bullmq";

/**
 * Resolves the run-queue kind. `GRAPH_RUN_QUEUE` wins; when it is unset the
 * engine defaults to the most performant durable queue (benchmarked by
 * `npm run bench:run-queues`: `bullmq` ≈ 851 runs/s vs `task-engine` ≈ 13),
 * which needs Redis/Dragonfly — without a queue URL it falls back to the
 * inline queue so single-process boots still work.
 */
export function resolveRunQueueKind(env: NodeJS.ProcessEnv): {
  kind: GraphRunQueueKind;
  /** True when `GRAPH_RUN_QUEUE` was unset and no queue URL was configured. */
  fallback: boolean;
} {
  const explicit = env["GRAPH_RUN_QUEUE"]?.trim().toLowerCase();
  if (explicit) {
    if (!["inline", "task-engine", "bullmq"].includes(explicit)) {
      throw new GraphExecutionError(
        `GRAPH_RUN_QUEUE must be inline, task-engine or bullmq; got '${explicit}'`,
        "GRAPH_RUN_CONFIG_INVALID"
      );
    }
    return { kind: explicit as GraphRunQueueKind, fallback: false };
  }
  if (env["GRAPH_QUEUE_REDIS_URL"]?.trim() || env["GRAPH_REDIS_URL"]?.trim()) {
    return { kind: "bullmq", fallback: false };
  }
  return { kind: "inline", fallback: true };
}

/**
 * Builds the run-service infrastructure options from the environment.
 *
 * @param adapter - The run adapter (persists `task-engine` tasks).
 * @param env - The environment (default `process.env`).
 */
export async function graphRunInfrastructureFromEnv(
  adapter: Adapter<any, any, any, any> | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<
  Pick<
    GraphRunServiceOptions,
    | "queue"
    | "bus"
    | "role"
    | "heartbeatMs"
    | "leaseMs"
    | "recoveryIntervalMs"
    | "maxQueueDepth"
    | "quotas"
  >
> {
  const role = (env["GRAPH_ROLE"]?.trim().toLowerCase() || "all") as "all" | "api" | "worker";
  if (!["all", "api", "worker"].includes(role)) {
    throw new GraphExecutionError(`GRAPH_ROLE must be all, api or worker; got '${role}'`, "GRAPH_RUN_CONFIG_INVALID");
  }
  const concurrency = integer(env, "GRAPH_WORKER_CONCURRENCY") ?? 4;
  const { kind, fallback } = resolveRunQueueKind(env);
  if (fallback) {
    console.warn(
      "[graph-backend] GRAPH_RUN_QUEUE unset and no GRAPH_QUEUE_REDIS_URL/GRAPH_REDIS_URL configured; " +
        "using the inline run queue (this process only). Set GRAPH_QUEUE_REDIS_URL to use the durable " +
        "BullMQ queue — the most performant variant per `npm run bench:run-queues`."
    );
  }
  let queue: GraphRunQueue;
  switch (kind) {
    case "inline":
      if (role !== "all") {
        throw new GraphExecutionError(
          "GRAPH_ROLE api/worker needs a shared queue (GRAPH_RUN_QUEUE=task-engine or bullmq)",
          "GRAPH_RUN_CONFIG_INVALID"
        );
      }
      queue = new InlineGraphRunQueue();
      break;
    case "task-engine": {
      const { TaskEngineGraphRunQueue } = await import("../../engine/runs/queue/TaskEngineGraphRunQueue");
      let taskAdapter = adapter;
      const taskRedis = env["GRAPH_TASK_ENGINE_REDIS_URL"]?.trim();
      if (taskRedis) {
        const { RedisAdapter } = await import("@decaf-ts/integrations/redis");
        const redis = new (RedisAdapter as unknown as new (conf: unknown, alias?: string) => Adapter<any, any, any, any>)(
          { url: taskRedis },
          "graph-task-engine"
        );
        await (redis as unknown as { initialize(): Promise<void> }).initialize();
        taskAdapter = redis;
      }
      if (!taskAdapter) {
        throw new GraphExecutionError(
          "GRAPH_RUN_QUEUE=task-engine needs the durable run adapter (GRAPH_DB_*) or GRAPH_TASK_ENGINE_REDIS_URL",
          "GRAPH_RUN_CONFIG_INVALID"
        );
      }
      queue = new TaskEngineGraphRunQueue({ adapter: taskAdapter, concurrency });
      break;
    }
    case "bullmq": {
      const { BullMqGraphRunQueue } = await import("../../engine/runs/queue/BullMqGraphRunQueue");
      queue = new BullMqGraphRunQueue({ url: redisUrl(env, "GRAPH_QUEUE_REDIS_URL"), concurrency });
      break;
    }
  }
  const busKind = env["GRAPH_BUS"]?.trim().toLowerCase() || "in-process";
  let bus: GraphRunBus;
  if (busKind === "redis" || busKind === "dragonfly") {
    const { RedisGraphRunBus } = await import("../../engine/runs/bus/RedisGraphRunBus");
    bus = new RedisGraphRunBus(redisUrl(env, "GRAPH_BUS_REDIS_URL"));
  } else if (busKind === "in-process") {
    if (role !== "all") {
      throw new GraphExecutionError(
        "GRAPH_ROLE api/worker needs a shared bus (GRAPH_BUS=redis)",
        "GRAPH_RUN_CONFIG_INVALID"
      );
    }
    bus = new InProcessGraphRunBus();
  } else {
    throw new GraphExecutionError(`GRAPH_BUS must be in-process or redis; got '${busKind}'`, "GRAPH_RUN_CONFIG_INVALID");
  }
  const maxQueueDepth = integer(env, "GRAPH_QUEUE_MAX_DEPTH");
  return {
    queue,
    bus,
    role,
    heartbeatMs: integer(env, "GRAPH_RUN_HEARTBEAT_MS") ?? 10_000,
    leaseMs: integer(env, "GRAPH_RUN_LEASE_MS") ?? 60_000,
    recoveryIntervalMs: integer(env, "GRAPH_RUN_RECOVERY_INTERVAL_MS") ?? 30_000,
    ...(maxQueueDepth !== undefined ? { maxQueueDepth } : {}),
    quotas: new GraphRunQuotaResolver(graphRunQuotaFromEnv(env), adapter),
  };
}
