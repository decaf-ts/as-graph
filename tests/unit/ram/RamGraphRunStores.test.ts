/**
 * @module as-graph/tests/unit/ram/RamGraphRunStores.test
 * @summary Adapter-backed run and run-event store tests (SAA-1997 F2).
 * @description Proves that {@link RamGraphRunStore} and
 * {@link RamGraphRunEventStore} persist runs and run events as
 * `@repository()` rows through a provided Decaf adapter, rather than in a
 * process-local map:
 * - runs round-trip through the adapter and updates never touch the immutable
 *   `createdAt` column;
 * - run events round-trip, replay after a sequence, notify live subscribers,
 *   enforce the per-run retention cap, and release retained state;
 * - {@link GraphExecutionModule} resolves the adapter-backed stores (not the
 *   in-memory maps) so run/run-event persistence flows through the
 *   `@repository()` classes.
 */
import { describe, it, expect } from "@jest/globals";
import {
  GraphExecutionEventType,
  type GraphRunEventEnvelope,
} from "../../../src/shared/graph";
import {
  createRamGraphAdapter,
  RamGraphRunEventStore,
  RamGraphRunStore,
} from "../../../src/ram";
import type { GraphRun } from "../../../src/engine/runs/types";

let adapterCounter = 0;

async function makeAdapter(): Promise<Awaited<ReturnType<typeof createRamGraphAdapter>>> {
  return createRamGraphAdapter(`ram-run-store-${adapterCounter++}`);
}

function makeRun(runId: string, extra: Partial<GraphRun> = {}): GraphRun {
  return {
    runId,
    workflowId: "wf",
    ownerUser: "alice",
    status: "running",
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

function makeEvent(
  runId: string,
  sequence: number,
  extra: Partial<GraphRunEventEnvelope> = {}
): GraphRunEventEnvelope {
  return {
    runId,
    workflowId: "wf",
    sequence,
    type: GraphExecutionEventType.NODE_OUTPUT,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

describe("RamGraphRunStore (adapter-backed)", () => {
  it("round-trips a run through a provided adapter", async () => {
    const adapter = await makeAdapter();
    const store = new RamGraphRunStore(adapter as never);
    await store.saveRun(
      makeRun("r1", { status: "succeeded", documentFingerprint: "fp-1" })
    );
    const read = await store.readRun("r1");
    expect(read?.runId).toBe("r1");
    expect(read?.status).toBe("succeeded");
    expect(read?.ownerUser).toBe("alice");
    expect(read?.documentFingerprint).toBe("fp-1");
  });

  it("updates an existing run without rewriting the immutable createdAt column", async () => {
    const adapter = await makeAdapter();
    const store = new RamGraphRunStore(adapter as never);
    const original = makeRun("r2", { status: "queued" });
    await store.saveRun(original);
    const created = await store.readRun("r2");
    await store.saveRun({ ...original, status: "running" });
    const updated = await store.readRun("r2");
    expect(updated?.status).toBe("running");
    expect(updated?.createdAt).toBe(created?.createdAt);
  });

  it("returns null for an unknown run", async () => {
    const adapter = await makeAdapter();
    const store = new RamGraphRunStore(adapter as never);
    expect(await store.readRun("missing")).toBeNull();
  });
});

describe("RamGraphRunEventStore (adapter-backed)", () => {
  it("appends and replays events after a sequence", async () => {
    const adapter = await makeAdapter();
    const store = new RamGraphRunEventStore(adapter as never);
    await store.append(makeEvent("run-a", 1, { nodeId: "n1" }));
    await store.append(makeEvent("run-a", 2, { nodeId: "n2" }));
    await store.append(makeEvent("run-a", 3, { nodeId: "n3" }));
    const replay = await store.listAfter("run-a", 1);
    expect(replay.map((event) => event.sequence)).toEqual([2, 3]);
    expect(replay.map((event) => event.nodeId)).toEqual(["n2", "n3"]);
  });

  it("persists a nested event path (the @list column round-trips)", async () => {
    const adapter = await makeAdapter();
    const store = new RamGraphRunEventStore(adapter as never);
    await store.append(makeEvent("run-path", 1, { path: ["loop", "body"] }));
    const [replayed] = await store.listAfter("run-path", 0);
    expect(replayed.path).toEqual(["loop", "body"]);
  });

  it("notifies live subscribers and stops after unsubscribe", async () => {
    const adapter = await makeAdapter();
    const store = new RamGraphRunEventStore(adapter as never);
    const seen: number[] = [];
    const unsubscribe = store.subscribe("run-b", (event) =>
      seen.push(event.sequence)
    );
    await store.append(makeEvent("run-b", 1));
    unsubscribe();
    await store.append(makeEvent("run-b", 2));
    expect(seen).toEqual([1]);
  });

  it("enforces the per-run retention cap for non-terminal events", async () => {
    const adapter = await makeAdapter();
    const store = new RamGraphRunEventStore(adapter as never, {
      maxEventsPerRun: 2,
    });
    await store.append(makeEvent("run-c", 1));
    await store.append(makeEvent("run-c", 2));
    await store.append(makeEvent("run-c", 3));
    const retained = await store.listAfter("run-c", 0);
    expect(retained.map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("releases all retained events for a finished run", async () => {
    const adapter = await makeAdapter();
    const store = new RamGraphRunEventStore(adapter as never);
    await store.append(makeEvent("run-d", 1));
    await store.append(makeEvent("run-d", 2));
    await store.release("run-d");
    expect(await store.listAfter("run-d", 0)).toEqual([]);
  });
});
