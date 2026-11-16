/**
 * @module as-graph/tests/unit/graph/runs/GraphRunOperations
 * @summary Run-service production behaviour: run data split, orphan recovery,
 * suspension, idempotency, admission control (concurrency, quotas,
 * backpressure) and graceful shutdown.
 */
import { describe, it, expect } from "@jest/globals";
import { GraphRunService } from "../../../../src/engine/runs/GraphRunService";
import { InMemoryGraphRunStore } from "../../../../src/engine/runs/InMemoryGraphRunStore";
import { InMemoryGraphRunEventStore } from "../../../../src/engine/runs/InMemoryGraphRunEventStore";
import {
  InMemoryGraphRunDataStore,
  graphRunResultSummaryOf,
} from "../../../../src/engine/runs/GraphRunDataStore";
import { GraphRunQuotaResolver } from "../../../../src/engine/runs/GraphRunQuotas";
import type { GraphRun } from "../../../../src/engine/runs/types";
import type { GraphRunQueue } from "../../../../src/engine/runs/queue/GraphRunQueue";
import { bootFixtureEngine } from "../../../fixtures/workflow-engine";
import { document, edge, node, port } from "../../../../src/workflows/builders";

const greet = document({
  id: "ops-greet",
  name: "ops-greet",
  inputs: [port("name")],
  outputs: [port("greeting")],
  nodes: [
    node("greet", "core.data.set", {
      includeOtherFields: true,
      assignments: [{ name: "hello", type: "string", value: "world" }],
    }),
  ],
  edges: [
    edge("e1", ["workflow", "name"], ["node", "greet", "value"]),
    edge("e2", ["node", "greet", "result"], ["workflow", "greeting"]),
  ],
});

const slow = document({
  id: "ops-slow",
  name: "ops-slow",
  inputs: [port("value")],
  outputs: [port("out")],
  nodes: [node("wait", "core.flow.delay", { timeoutMs: 30_000 })],
  edges: [
    edge("e1", ["workflow", "value"], ["node", "wait", "value"]),
    edge("e2", ["node", "wait", "value"], ["workflow", "out"]),
  ],
});

async function service(
  options: ConstructorParameters<typeof GraphRunService>[3] = {}
) {
  const { engine } = await bootFixtureEngine();
  const runStore = new InMemoryGraphRunStore();
  const eventStore = new InMemoryGraphRunEventStore();
  const runData = new InMemoryGraphRunDataStore();
  const runs = new GraphRunService(engine, runStore, eventStore, {
    runData,
    recoveryIntervalMs: 0,
    ...options,
  });
  return { runs, runStore, eventStore, runData };
}

describe("run data split (n8n's execution_entity / execution_data)", () => {
  it("keeps a summary on the row and the full result in run data; GET reassembles it", async () => {
    const { runs, runStore, runData } = await service();
    const created = await runs.createRun({ workflow: greet, inputs: { name: { who: "ada" } } }, null);
    const finished = await runs.waitForRun(created.runId, null);
    expect(finished.status).toBe("succeeded");

    const row = (await runStore.readRun(created.runId))!;
    // The row: outputs and per-node status only.
    expect(row.result?.outputs).toEqual({ greeting: { who: "ada", hello: "world" } });
    expect(row.result?.nodeResults["greet"]).not.toHaveProperty("inputs");
    expect(row.result?.nodeResults["greet"]).not.toHaveProperty("outputs");
    expect(row.result).not.toHaveProperty("document");
    expect(row.storedBytes).toBeGreaterThan(0);

    // The data object: the request and the full result (no events).
    const data = (await runData.load(created.runId))!;
    expect(data.request?.inputs).toEqual({ name: { who: "ada" } });
    expect(data.result?.nodeResults["greet"].outputs).toEqual({
      result: { who: "ada", hello: "world" },
    });
    expect(data.result).not.toHaveProperty("events");

    // GET reassembles the full result.
    const read = await runs.getRun(created.runId, null);
    expect(read.result?.nodeResults["greet"].inputs).toEqual({ value: { who: "ada" } });
    expect(read.result?.document?.id).toBe("ops-greet");

    // Deleting the run deletes its data object.
    await runs.deleteRun(created.runId, null);
    expect(await runData.load(created.runId)).toBeUndefined();
    await runs.shutdown(100);
  });

  it("replaces an oversized summary output with a marker", () => {
    process.env["GRAPH_RUN_SUMMARY_OUTPUT_MAX_BYTES"] = "10";
    try {
      const summary = graphRunResultSummaryOf({
        runId: "r",
        workflowId: "w",
        status: "succeeded",
        outputs: { big: "x".repeat(100) },
        nodeResults: {},
        events: [],
      } as never);
      expect(summary.outputs).toEqual({ truncated: true, bytes: expect.any(Number) });
    } finally {
      delete process.env["GRAPH_RUN_SUMMARY_OUTPUT_MAX_BYTES"];
    }
  });
});

describe("orphan recovery", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 15, 12) + ms).toISOString();

  it("fails runs whose worker stopped beating, continuing their event sequence", async () => {
    const { runs, runStore, eventStore } = await service({ leaseMs: 60_000 });
    const now = new Date(Date.UTC(2026, 10, 15, 12) + 120_000);
    const base = { workflowId: "wf", ownerUser: null, createdAt: at(0) } as const;
    await runStore.saveRun({ ...base, runId: "dead", status: "running", workerId: "w1", heartbeatAt: at(0) } as GraphRun);
    await runStore.saveRun({ ...base, runId: "alive", status: "running", heartbeatAt: at(100_000) } as GraphRun);
    await runStore.saveRun({ ...base, runId: "waiting", status: "running", heartbeatAt: at(0), suspendedAt: at(1) } as GraphRun);
    await runStore.saveRun({ ...base, runId: "lost", status: "queued" } as GraphRun);
    await eventStore.append({ runId: "dead", workflowId: "wf", sequence: 1, type: "workflow.started", timestamp: at(0) } as never);
    await eventStore.append({ runId: "dead", workflowId: "wf", sequence: 2, type: "node.started", timestamp: at(0) } as never);

    // Inline queue: a queued run dies with the process, so it is recovered too.
    const recovered = await runs.recoverOrphanedRuns(now);
    expect(recovered.sort()).toEqual(["dead", "lost"]);
    const dead = (await runStore.readRun("dead"))!;
    expect(dead.status).toBe("failed");
    expect(dead.error?.code).toBe("GRAPH_RUN_ORPHANED");
    const events = await eventStore.listAfter("dead", 0);
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "workflow.started"],
      [2, "node.started"],
      [3, "workflow.failed"],
    ]);
    expect((await runStore.readRun("alive"))!.status).toBe("running");
    expect((await runStore.readRun("waiting"))!.status).toBe("running");
    await runs.shutdown(100);
  });

  it("leaves queued runs alone when the queue is durable", async () => {
    const durable: GraphRunQueue = {
      kind: "test",
      durable: true,
      start: async () => undefined,
      enqueue: async () => undefined,
      depth: async () => 0,
      ping: async () => true,
      stop: async () => undefined,
    };
    const { runs, runStore } = await service({ queue: durable });
    await runStore.saveRun({ runId: "waiting-for-worker", workflowId: "wf", ownerUser: null, status: "queued", createdAt: at(0) } as GraphRun);
    expect(await runs.recoverOrphanedRuns(new Date(Date.UTC(2026, 10, 16)))).toEqual([]);
    await runs.shutdown(100);
  });
});

describe("graphRunTimeOf", () => {
  it("reads Dates, ISO strings and Decaf formatted (local-time) dates", async () => {
    const { graphRunTimeOf } = await import("../../../../src/engine/runs/GraphRunConverters");
    const local = new Date(2026, 10, 15, 19, 4, 36, 783);
    expect(graphRunTimeOf(local)).toBe(local.getTime());
    expect(graphRunTimeOf(local.toISOString())).toBe(local.getTime());
    expect(graphRunTimeOf("15-11-2026 19:04:36:783")).toBe(local.getTime());
    expect(graphRunTimeOf("15/11/2026 19:04:36:7")).toBe(new Date(2026, 10, 15, 19, 4, 36, 700).getTime());
    expect(graphRunTimeOf("nonsense")).toBeNaN();
  });
});

describe("idempotency", () => {
  it("returns the original run for a repeat, and rejects the key with another request", async () => {
    const { runs } = await service();
    const first = await runs.createRun(
      { workflow: greet, inputs: { name: 1 }, idempotencyKey: "abc" },
      "ada"
    );
    const again = await runs.createRun(
      { workflow: greet, inputs: { name: 1 }, idempotencyKey: "abc" },
      "ada"
    );
    expect(again.runId).toBe(first.runId);
    await expect(
      runs.createRun({ workflow: greet, inputs: { name: 2 }, idempotencyKey: "abc" }, "ada")
    ).rejects.toMatchObject({ graphCode: "GRAPH_RUN_IDEMPOTENCY_CONFLICT" });
    // Keys are per caller.
    const other = await runs.createRun(
      { workflow: greet, inputs: { name: 2 }, idempotencyKey: "abc" },
      "grace"
    );
    expect(other.runId).not.toBe(first.runId);
    await runs.shutdown(100);
  });
});

describe("admission control", () => {
  it("rejects above the per-caller concurrency limit", async () => {
    const { runs } = await service({ limits: { maxConcurrentRuns: 1 } });
    await runs.createRun({ workflow: slow, inputs: { value: 1 } }, "ada");
    await expect(runs.createRun({ workflow: slow, inputs: { value: 1 } }, "ada")).rejects.toMatchObject({
      graphCode: "GRAPH_RUN_CONCURRENCY_LIMIT",
    });
    await runs.shutdown(100);
  });

  it("applies tenant quotas: active runs, runs per minute, stored bytes", async () => {
    const active = await service({ quotas: new GraphRunQuotaResolver({ maxActiveRuns: 1 }) });
    await active.runs.createRun({ workflow: slow, inputs: { value: 1 } }, "ada");
    await expect(active.runs.createRun({ workflow: slow, inputs: { value: 1 } }, "ada")).rejects.toMatchObject({
      graphCode: "GRAPH_QUOTA_EXCEEDED",
    });
    await active.runs.shutdown(100);

    const rate = await service({ quotas: new GraphRunQuotaResolver({ maxRunsPerMinute: 2 }) });
    for (let i = 0; i < 2; i++) {
      const run = await rate.runs.createRun({ workflow: greet, inputs: { name: i } }, "ada");
      await rate.runs.waitForRun(run.runId, "ada");
    }
    await expect(rate.runs.createRun({ workflow: greet, inputs: { name: 9 } }, "ada")).rejects.toMatchObject({
      graphCode: "GRAPH_QUOTA_EXCEEDED",
    });
    await rate.runs.shutdown(100);

    const storage = await service({ quotas: new GraphRunQuotaResolver({ maxStoredBytes: 1 }) });
    const first = await storage.runs.createRun({ workflow: greet, inputs: { name: 1 } }, "ada");
    await storage.runs.waitForRun(first.runId, "ada");
    await expect(storage.runs.createRun({ workflow: greet, inputs: { name: 2 } }, "ada")).rejects.toMatchObject({
      graphCode: "GRAPH_QUOTA_STORAGE_EXCEEDED",
    });
    await storage.runs.shutdown(100);
  });

  it("rejects when the queue is deeper than the limit (backpressure)", async () => {
    const deep: GraphRunQueue = {
      kind: "test",
      durable: true,
      start: async () => undefined,
      enqueue: async () => undefined,
      depth: async () => 5,
      ping: async () => true,
      stop: async () => undefined,
    };
    const { runs } = await service({ queue: deep, maxQueueDepth: 5 });
    await expect(runs.createRun({ workflow: greet, inputs: {} }, "ada")).rejects.toMatchObject({
      graphCode: "GRAPH_RUN_QUEUE_FULL",
    });
    await runs.shutdown(100);
  });
});

describe("graceful shutdown", () => {
  it("interrupts runs still executing after the grace period and refuses new ones", async () => {
    const { runs, runStore } = await service();
    const run = await runs.createRun({ workflow: slow, inputs: { value: 1 } }, null);
    for (let i = 0; i < 50 && (await runStore.readRun(run.runId))?.status !== "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await runs.shutdown(50);
    const interrupted = (await runStore.readRun(run.runId))!;
    expect(interrupted.status).toBe("failed");
    expect(interrupted.error?.code).toBe("GRAPH_RUN_INTERRUPTED");
    await expect(runs.createRun({ workflow: greet, inputs: {} }, null)).rejects.toMatchObject({
      graphCode: "GRAPH_RUN_SHUTTING_DOWN",
    });
  });
});
