/**
 * @module as-graph/tests/unit/graph/runs/GraphRunQueueKind
 * @summary Run-queue kind resolution: the explicit `GRAPH_RUN_QUEUE` wins,
 * the default is the most performant durable variant (`bullmq`) when a
 * Redis/Dragonfly URL is configured, and `inline` is the single-process
 * fallback.
 */
import { describe, it, expect } from "@jest/globals";
import { resolveRunQueueKind } from "../../../../src/nest/graph/GraphRunInfrastructure";

describe("resolveRunQueueKind", () => {
  it("defaults to bullmq when a queue Redis URL is configured", () => {
    const { kind, fallback } = resolveRunQueueKind({
      GRAPH_QUEUE_REDIS_URL: "redis://127.0.0.1:56380",
    });
    expect(kind).toBe("bullmq");
    expect(fallback).toBe(false);
  });

  it("defaults to bullmq on the generic GRAPH_REDIS_URL too", () => {
    const { kind, fallback } = resolveRunQueueKind({ GRAPH_REDIS_URL: "redis://127.0.0.1:56380" });
    expect(kind).toBe("bullmq");
    expect(fallback).toBe(false);
  });

  it("falls back to inline without any queue URL", () => {
    const { kind, fallback } = resolveRunQueueKind({});
    expect(kind).toBe("inline");
    expect(fallback).toBe(true);
  });

  it("an explicit GRAPH_RUN_QUEUE wins over the URL-based default", () => {
    expect(
      resolveRunQueueKind({ GRAPH_RUN_QUEUE: "inline", GRAPH_QUEUE_REDIS_URL: "redis://x" }).kind
    ).toBe("inline");
    expect(resolveRunQueueKind({ GRAPH_RUN_QUEUE: "inline" }).fallback).toBe(false);
    expect(resolveRunQueueKind({ GRAPH_RUN_QUEUE: "task-engine" }).kind).toBe("task-engine");
    expect(resolveRunQueueKind({ GRAPH_RUN_QUEUE: "BullMQ" }).kind).toBe("bullmq");
  });

  it("rejects an unknown explicit kind", () => {
    expect(() => resolveRunQueueKind({ GRAPH_RUN_QUEUE: "celery" })).toThrow(
      "GRAPH_RUN_QUEUE must be inline, task-engine or bullmq; got 'celery'"
    );
  });
});
