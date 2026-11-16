/**
 * @module as-graph/tests/integration/graph/distributedRunHarness
 * @summary An `api` and a `worker` run service sharing what a real deployment
 * shares (run rows, run data, stored events), talking through the Dragonfly
 * run bus — and the scenario every queue backend must pass.
 * @description Each "process" has its own engine, queue client and bus
 * connection; stored events are shared while each process notifies only its
 * own listeners, so live events can only cross processes through the bus.
 * It imports only the inline queue: the TaskEngine models must be flavoured
 * for one adapter per process (`TaskEngineGraphRunQueue` is loaded by the
 * suites that pick it).
 */
import { expect } from "@jest/globals";
import type { GraphRunEventEnvelope } from "../../../src/shared/graph";
import { GraphRunService } from "../../../src/engine/runs/GraphRunService";
import { InMemoryGraphRunStore } from "../../../src/engine/runs/InMemoryGraphRunStore";
import { InMemoryGraphRunDataStore } from "../../../src/engine/runs/GraphRunDataStore";
import type { GraphRunEventStore } from "../../../src/engine/runs/types";
import type { GraphRunQueue } from "../../../src/engine/runs/queue/GraphRunQueue";
import {
  BusGraphRunEventStore,
  InProcessGraphRunBus,
} from "../../../src/engine/runs/bus/GraphRunBus";
import { InlineGraphRunQueue } from "../../../src/engine/runs/queue/GraphRunQueue";
import type { GraphRunLimits } from "../../../src/shared/graph/constants";
import { RedisGraphRunBus } from "../../../src/engine/runs/bus/RedisGraphRunBus";
import { bootFixtureEngine } from "../../fixtures/workflow-engine";
import { document, edge, node, port } from "../../../src/workflows/builders";

/** Event rows shared by every process; listeners are per process. */
class SharedEvents {
  readonly rows = new Map<string, GraphRunEventEnvelope[]>();
}

/** One process's view of the shared event rows. */
class ProcessEventStore implements GraphRunEventStore {
  private readonly listeners = new Map<string, Set<(event: GraphRunEventEnvelope) => void>>();
  constructor(private readonly shared: SharedEvents) {}
  async append(event: GraphRunEventEnvelope): Promise<void> {
    const list = this.shared.rows.get(event.runId) ?? [];
    list.push(event);
    this.shared.rows.set(event.runId, list);
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
  }
  async listAfter(runId: string, sequence: number): Promise<GraphRunEventEnvelope[]> {
    return (this.shared.rows.get(runId) ?? []).filter((event) => event.sequence > sequence);
  }
  subscribe(runId: string, listener: (event: GraphRunEventEnvelope) => void): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => set.delete(listener);
  }
  async lastSequence(runId: string): Promise<number> {
    const list = this.shared.rows.get(runId) ?? [];
    return list.length ? list[list.length - 1].sequence : 0;
  }
}

export const greetWorkflow = document({
  id: "distributed-greet",
  name: "distributed-greet",
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

export const slowWorkflow = document({
  id: "distributed-slow",
  name: "distributed-slow",
  inputs: [port("value")],
  outputs: [port("out")],
  nodes: [node("wait", "core.flow.delay", { timeoutMs: 20_000 })],
  edges: [
    edge("e1", ["workflow", "value"], ["node", "wait", "value"]),
    edge("e2", ["node", "wait", "value"], ["workflow", "out"]),
  ],
});

/** Options of {@link distributedPair}. */
export interface DistributedPairOptions {
  /** Worker services (default 1). */
  workers?: number;
  /** Run limits of every service (merged over the defaults). */
  limits?: GraphRunLimits;
  /**
   * `"inline"`: one `all`-role service on the inline queue and the in-process
   * bus — the single-process baseline; `api` is that service, `workers` is
   * `[api]`. Default `"distributed"`: an `api` + worker services on the
   * given queue, over the Dragonfly bus.
   */
  mode?: "distributed" | "inline";
}

/** Builds the api + worker services on one queue backend. */
export async function distributedPair(
  dragonfly: string,
  makeQueue: () => Promise<GraphRunQueue>,
  options: DistributedPairOptions = {}
) {
  const runStore = new InMemoryGraphRunStore();
  const runData = new InMemoryGraphRunDataStore();
  const shared = new SharedEvents();
  if (options.mode === "inline") {
    const { engine } = await bootFixtureEngine();
    const bus = new InProcessGraphRunBus();
    const service = new GraphRunService(
      engine,
      runStore,
      new BusGraphRunEventStore(new ProcessEventStore(shared), bus),
      {
        role: "all",
        queue: new InlineGraphRunQueue(),
        bus,
        runData,
        recoveryIntervalMs: 0,
        ...(options.limits ? { limits: options.limits } : {}),
      }
    );
    await service.start();
    return { api: service, worker: service, workers: [service], runStore };
  }
  const make = async (role: "api" | "worker") => {
    const { engine } = await bootFixtureEngine();
    const bus = new RedisGraphRunBus(dragonfly);
    const service = new GraphRunService(
      engine,
      runStore,
      new BusGraphRunEventStore(new ProcessEventStore(shared), bus),
      {
        role,
        queue: await makeQueue(),
        bus,
        runData,
        heartbeatMs: 200,
        recoveryIntervalMs: 0,
        ...(options.limits ? { limits: options.limits } : {}),
      }
    );
    await service.start();
    return service;
  };
  const api = await make("api");
  const workers: GraphRunService[] = [];
  for (let i = 0; i < Math.max(1, options.workers ?? 1); i++) workers.push(await make("worker"));
  return { api, worker: workers[0], workers, runStore };
}

/**
 * The scenario every queue must pass: the worker executes a run created on
 * the API side, the API's subscriber receives its live events over the bus,
 * and a cancel issued on the API side stops it on the worker.
 */
export async function assertDistributedRuns(
  dragonfly: string,
  makeQueue: () => Promise<GraphRunQueue>
): Promise<void> {
  const { api, worker, runStore } = await distributedPair(dragonfly, makeQueue);
  const executing = (service: GraphRunService) =>
    (service as unknown as { executing: Set<string> }).executing;
  try {
    const created = await api.createRun({ workflow: greetWorkflow, inputs: { name: { who: "ada" } } }, null);
    const seen: string[] = [];
    const unsubscribe = await api.subscribeEvents(created.runId, null, (event) => {
      seen.push(event.type);
    });
    const finished = await api.waitForRun(created.runId, null);
    unsubscribe();
    expect(finished.status).toBe("succeeded");
    expect(finished.result?.outputs).toEqual({ greeting: { who: "ada", hello: "world" } });
    expect((await runStore.readRun(created.runId))?.workerId).toBe(worker.workerId);
    expect(seen).toContain("workflow.completed");

    const long = await api.createRun({ workflow: slowWorkflow, inputs: { value: 1 } }, null);
    for (let i = 0; i < 100; i++) {
      if (executing(worker).has(long.runId)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(executing(worker).has(long.runId)).toBe(true);
    const started = Date.now();
    await api.cancelRun(long.runId, null);
    for (let i = 0; i < 100 && executing(worker).has(long.runId); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(executing(worker).has(long.runId)).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await runStore.readRun(long.runId))?.status).toBe("cancelled");
  } finally {
    await api.shutdown(1_000);
    await worker.shutdown(1_000);
  }
}
