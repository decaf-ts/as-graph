/**
 * @module as-graph/tests/unit/graph/binary/GraphBinaryRetention
 * @summary Binary holders, the blob-backed binary store, pin holding and run
 * retention, over the integrations in-memory blob service.
 * @description The S3 path of the same store runs against real MinIO in
 * `tests/integration/graph/binaryStoreS3.test.ts`; here the integrations
 * `MemoryBlobStoreService` stands in, so the holder/release bookkeeping, pin
 * holding and retention rules are covered without a network service.
 */
import { describe, it, expect } from "@jest/globals";
import { MemoryBlobStoreService } from "@decaf-ts/integrations/blob/memory";
import type { BlobStoreService } from "@decaf-ts/integrations/blob";
import {
  BlobGraphBinaryStore,
  InMemoryGraphBinaryStore,
  graphBinaryIdOf,
  graphBinaryIdsOf,
  graphBinaryPinHolder,
  graphBinaryStoreProviderFromEnv,
  createGraphBinaryStore,
  type GraphBinaryStore,
} from "../../../../src/engine";
import { GraphRunService } from "../../../../src/engine/runs/GraphRunService";
import { InMemoryGraphRunStore } from "../../../../src/engine/runs/InMemoryGraphRunStore";
import { InMemoryGraphRunEventStore } from "../../../../src/engine/runs/InMemoryGraphRunEventStore";
import type { GraphRun } from "../../../../src/engine/runs/types";
import { GraphPinningService } from "../../../../src/engine/pinning/GraphPinningService";
import { GraphPinningPolicy } from "../../../../src/engine/pinning/GraphPinningPolicy";
import { GraphPinningDependencyResolver } from "../../../../src/engine/pinning/GraphPinningDependencyResolver";
import { GraphExecutionPlanner } from "../../../../src/engine/planning/GraphExecutionPlanner";
import {
  createGraphValueRepository,
  serializeGraphValueKey,
} from "../../../../src/engine/store/GraphValueRepository";
import { createRamGraphAdapter } from "../../../../src/ram";
import { graphRunRetentionFromEnv } from "../../../../src/nest/graph/GraphBackendHost";
import { bootFixtureEngine } from "../../../fixtures/workflow-engine";
import { linearDocument, resolveDocument } from "../engine-fixtures";
import type { GraphExecutionResult } from "../../../../src/engine/types";

const PDF = { fileName: "a.pdf", mimeType: "application/pdf", byteLength: 3 };

async function memoryBlobs(prefix?: string): Promise<BlobStoreService> {
  const service = new MemoryBlobStoreService();
  await service.boot({
    provider: "memory",
    sourceId: `graph-binary-${Math.random()}`,
    ...(prefix ? { prefix } : {}),
  });
  return service as unknown as BlobStoreService;
}

/** Shared holder contract, run against both built-in store kinds. */
function holderContract(name: string, make: () => Promise<GraphBinaryStore>) {
  describe(`${name} — holders`, () => {
    it("serves bytes and descriptor to the runs that hold them", async () => {
      const store = await make();
      const bytes = Buffer.from("pdf");
      const id = await store.write("run-1", bytes, { ...PDF, path: "in/a b.pdf" });
      expect(id).toBe(graphBinaryIdOf(bytes));
      expect(await store.read(id)).toEqual(bytes);
      expect(await store.describe(id)).toEqual({ ...PDF, path: "in/a b.pdf" });
      expect(await store.belongsTo("run-1", id)).toBe(true);
      expect(await store.belongsTo("run-2", id)).toBe(false);
      await store.retain("run-2", id);
      expect(await store.belongsTo("run-2", id)).toBe(true);
    });

    it("deletes bytes only when the last holder is released", async () => {
      const store = await make();
      const id = await store.write("run-1", Buffer.from("pdf"), PDF);
      await store.retain("run-2", id);
      await store.hold(graphBinaryPinHolder("wf:node:fp"), id);

      await store.deleteRun("run-1");
      expect(await store.read(id)).toBeDefined();
      expect(await store.belongsTo("run-1", id)).toBe(false);
      await store.deleteRun("run-2");
      // The pin still holds the file after every run is gone.
      expect(await store.read(id)).toEqual(Buffer.from("pdf"));
      await store.releaseHolder(graphBinaryPinHolder("wf:node:fp"));
      expect(await store.read(id)).toBeUndefined();
      expect(await store.describe(id)).toBeUndefined();
    });

    it("keeps one copy of identical bytes and ignores malformed ids", async () => {
      const store = await make();
      const a = await store.write("run-1", Buffer.from("same"), PDF);
      const b = await store.write("run-2", Buffer.from("same"), PDF);
      expect(a).toBe(b);
      await store.deleteRun("run-1");
      expect(await store.read(a)).toEqual(Buffer.from("same"));
      expect(await store.read("graph-binary:../../etc")).toBeUndefined();
      expect(await store.belongsTo("run-2", "nope")).toBe(false);
    });
  });
}

holderContract("InMemoryGraphBinaryStore", async () => new InMemoryGraphBinaryStore());
holderContract("BlobGraphBinaryStore (memory blob service)", async () =>
  new BlobGraphBinaryStore(await memoryBlobs(), { deleteGraceMs: 0 })
);
holderContract("BlobGraphBinaryStore (prefixed blob service)", async () =>
  new BlobGraphBinaryStore(await memoryBlobs("tenant-a/graph"), { deleteGraceMs: 0 })
);

describe("InMemoryGraphBinaryStore — eviction", () => {
  it("never evicts a binary a pin holds", async () => {
    const store = new InMemoryGraphBinaryStore(8);
    const pinned = await store.write("run-1", Buffer.from("12345"), PDF);
    await store.hold(graphBinaryPinHolder("k"), pinned);
    const other = await store.write("run-1", Buffer.from("abcde"), PDF);
    expect(await store.read(pinned)).toBeDefined();
    expect(await store.read(other)).toBeDefined();
  });
});

describe("BlobGraphBinaryStore — durability", () => {
  it("a second store over the same blob service sees the files and holders", async () => {
    const blobs = await memoryBlobs();
    // The index lives in the adapter's tables: a restarted process shares
    // the bucket and the database.
    const adapter = (await createRamGraphAdapter(`binary-index-${Math.random()}`)) as never;
    const first = new BlobGraphBinaryStore(blobs, { adapter, deleteGraceMs: 0 });
    const id = await first.write("run-1", Buffer.from("pdf"), PDF);
    // A restarted process: a new store instance, same bucket.
    const second = new BlobGraphBinaryStore(blobs, { adapter, deleteGraceMs: 0 });
    expect(await second.read(id)).toEqual(Buffer.from("pdf"));
    expect(await second.belongsTo("run-1", id)).toBe(true);
    await second.deleteRun("run-1");
    expect(await first.read(id)).toBeUndefined();
  });
});

describe("BlobGraphBinaryStore — deferred deletion", () => {
  it("keeps released bytes for the grace period and lets a writer reclaim them", async () => {
    const store = new BlobGraphBinaryStore(await memoryBlobs(), { deleteGraceMs: 60_000 });
    const id = await store.write("run-1", Buffer.from("grace"), PDF);
    await store.deleteRun("run-1");
    // Unheld, but within the grace period: still readable.
    expect(await store.read(id)).toEqual(Buffer.from("grace"));
    expect(await store.sweep(new Date(Date.now() + 1_000))).toBe(0);

    // A writer holding it again within the grace period keeps it for good.
    await store.write("run-2", Buffer.from("grace"), PDF);
    expect(await store.sweep(new Date(Date.now() + 120_000))).toBe(0);
    expect(await store.read(id)).toEqual(Buffer.from("grace"));

    // Released again and past the grace period: the sweep deletes it.
    await store.deleteRun("run-2");
    expect(await store.sweep(new Date(Date.now() + 120_000))).toBe(1);
    expect(await store.read(id)).toBeUndefined();
    expect(await store.describe(id)).toBeUndefined();
  });

  it("streams writes and reads without buffering the source", async () => {
    const store = new BlobGraphBinaryStore(await memoryBlobs(), { deleteGraceMs: 0 });
    const chunks = ["a,b\n", "1,2\n", "3,4\n"].map((text) => Buffer.from(text));
    const { id, byteLength } = await store.writeStream(
      "run-s",
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
      { fileName: "s.csv", mimeType: "text/csv" }
    );
    expect(id).toBe(graphBinaryIdOf(Buffer.concat(chunks)));
    expect(byteLength).toBe(12);
    const read: Buffer[] = [];
    for await (const chunk of (await store.openStream(id))!) read.push(Buffer.from(chunk));
    expect(Buffer.concat(read).toString()).toBe("a,b\n1,2\n3,4\n");
    // The temporary upload key is gone; only bytes remain in the blob store.
    const keys = (await store.service.list({})).items.map((item) => item.key);
    expect(keys.every((key) => /bytes\/[0-9a-f]{64}$/.test(key))).toBe(true);
    expect(await store.describe(id)).toEqual({
      fileName: "s.csv",
      mimeType: "text/csv",
      byteLength: 12,
    });
  });
});

describe("graphBinaryIdsOf", () => {
  it("collects every reference id inside a value once", () => {
    const ref = (id: string) => ({ ...PDF, id: `graph-binary:${id.repeat(64)}` });
    expect(
      graphBinaryIdsOf({ a: ref("a"), list: [ref("b"), { nested: ref("a") }], n: 1 })
    ).toEqual([`graph-binary:${"a".repeat(64)}`, `graph-binary:${"b".repeat(64)}`]);
  });
});

describe("binary store selection from the environment", () => {
  it("defaults to s3 and rejects unknown providers", () => {
    expect(graphBinaryStoreProviderFromEnv({})).toBe("s3");
    expect(graphBinaryStoreProviderFromEnv({ GRAPH_BINARY_STORE: "local" })).toBe("local");
    expect(() =>
      graphBinaryStoreProviderFromEnv({ GRAPH_BINARY_STORE: "ftp" })
    ).toThrow(expect.objectContaining({ graphCode: "GRAPH_BINARY_STORE_UNKNOWN_PROVIDER" }));
  });

  it("fails closed when the selected provider has no configuration", async () => {
    await expect(createGraphBinaryStore({ provider: "s3" })).rejects.toMatchObject({
      graphCode: "GRAPH_BINARY_STORE_NOT_CONFIGURED",
    });
  });

  it("boots the memory provider from an explicit config", async () => {
    const store = await createGraphBinaryStore({
      provider: "memory",
      config: { provider: "memory", sourceId: "explicit" },
    });
    const id = await store.write("r", Buffer.from("x"), PDF);
    expect(await store.read(id)).toEqual(Buffer.from("x"));
  });
});

describe("run retention configuration (graphRunRetentionFromEnv)", () => {
  it("defaults to n8n's 14 days / 10000 runs, hourly", () => {
    expect(graphRunRetentionFromEnv({})).toEqual({
      maxAgeMs: 336 * 3_600_000,
      maxCount: 10_000,
      intervalMs: 3_600_000,
      pinSweepIntervalMs: 3_600_000,
    });
  });

  it("reads overrides, disables single limits or the whole feature", () => {
    expect(
      graphRunRetentionFromEnv({
        GRAPH_RUN_MAX_AGE_HOURS: "2",
        GRAPH_RUN_MAX_COUNT: "off",
        GRAPH_RUN_PRUNE_INTERVAL_MINUTES: "0",
        GRAPH_PIN_SWEEP_INTERVAL_MINUTES: "5",
      })
    ).toEqual({ maxAgeMs: 7_200_000, intervalMs: 0, pinSweepIntervalMs: 300_000 });
    expect(graphRunRetentionFromEnv({ GRAPH_RUN_RETENTION: "off" })).toBeUndefined();
    expect(() => graphRunRetentionFromEnv({ GRAPH_RUN_MAX_COUNT: "lots" })).toThrow(
      expect.objectContaining({ graphCode: "GRAPH_RUN_RETENTION_INVALID" })
    );
  });
});

describe("GraphRunService — run retention", () => {
  const HOUR = 3_600_000;
  const NOW = new Date("2026-11-15T12:00:00Z");

  function run(runId: string, status: GraphRun["status"], hoursAgo: number): GraphRun {
    const at = new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
    return {
      runId,
      workflowId: "wf",
      status,
      createdAt: at,
      ...(status === "running" ? {} : { finishedAt: at }),
    } as GraphRun;
  }

  async function setup(retention: { maxAgeMs?: number; maxCount?: number }) {
    const blobs = new BlobGraphBinaryStore(await memoryBlobs(), { deleteGraceMs: 0 });
    const { engine } = await bootFixtureEngine({ binaryStore: blobs });
    const runStore = new InMemoryGraphRunStore();
    const eventStore = new InMemoryGraphRunEventStore();
    const service = new GraphRunService(engine, runStore, eventStore, {
      retention: { ...retention, intervalMs: 0 },
    });
    return { blobs, runStore, eventStore, service };
  }

  it("prunes runs older than the max age with their events and files, keeping running ones", async () => {
    const { blobs, runStore, eventStore, service } = await setup({ maxAgeMs: 24 * HOUR });
    await runStore.saveRun(run("old", "succeeded", 48));
    await runStore.saveRun(run("old-failed", "failed", 30));
    await runStore.saveRun(run("fresh", "succeeded", 1));
    await runStore.saveRun(run("stuck", "running", 100));
    const oldFile = await blobs.write("old", Buffer.from("old"), PDF);
    const freshFile = await blobs.write("fresh", Buffer.from("fresh"), PDF);
    await eventStore.append({ runId: "old", sequence: 1, type: "workflow.completed" } as never);

    const pruned = await service.pruneRuns(NOW);

    expect(pruned.sort()).toEqual(["old", "old-failed"]);
    expect(await runStore.readRun("old")).toBeNull();
    expect(await runStore.readRun("stuck")).not.toBeNull();
    expect(await runStore.readRun("fresh")).not.toBeNull();
    expect(await eventStore.listAfter("old", 0)).toEqual([]);
    expect(await blobs.read(oldFile)).toBeUndefined();
    expect(await blobs.read(freshFile)).toEqual(Buffer.from("fresh"));
    service.dispose();
  });

  it("keeps only the newest max-count finished runs", async () => {
    const { runStore, service } = await setup({ maxCount: 2 });
    for (const [id, hours] of [["a", 5], ["b", 4], ["c", 3], ["d", 2]] as const) {
      await runStore.saveRun(run(id, "succeeded", hours));
    }
    expect((await service.pruneRuns(NOW)).sort()).toEqual(["a", "b"]);
    expect(
      (await runStore.listPrunableRuns({ keepNewest: 0, limit: 100 })).map((r) => r.runId).sort()
    ).toEqual([
      "c",
      "d",
    ]);
    service.dispose();
  });

  it("deletes a finished run on request and refuses an unfinished one", async () => {
    const { blobs, runStore, eventStore, service } = await setup({});
    await runStore.saveRun(run("done", "succeeded", 1));
    await runStore.saveRun(run("busy", "running", 1));
    const file = await blobs.write("done", Buffer.from("done"), PDF);
    await eventStore.append({ runId: "done", sequence: 1, type: "workflow.completed" } as never);

    await expect(service.deleteRun("busy", null)).rejects.toMatchObject({
      graphCode: "GRAPH_RUN_DELETE_ACTIVE",
    });
    await expect(service.deleteRun("missing", null)).rejects.toThrow(/No graph run/);
    expect((await service.deleteRun("done", null)).runId).toBe("done");
    expect(await runStore.readRun("done")).toBeNull();
    expect(await eventStore.listAfter("done", 0)).toEqual([]);
    expect(await blobs.read(file)).toBeUndefined();
    expect(await runStore.readRun("busy")).not.toBeNull();
    service.dispose();
  });

  it("keeps a file a pin holds after its run is pruned, and frees it on unpin", async () => {
    const { blobs, runStore, service } = await setup({ maxAgeMs: HOUR });
    await runStore.saveRun(run("pinned-run", "succeeded", 10));
    const id = await blobs.write("pinned-run", Buffer.from("keep"), PDF);

    const resolved = await resolveDocument(linearDocument());
    const plan = await new GraphExecutionPlanner().plan(resolved);
    const node = plan.nodes[0];
    node.instance.metadata = {
      pinnable: { enabled: true, strategy: "manual", includeDependencies: false },
    };
    node.metadata = node.instance.metadata;
    const pinning = new GraphPinningService(
      createGraphValueRepository(
        (await createRamGraphAdapter(`retention-pin-${Math.random()}`)) as never
      ),
      new GraphPinningPolicy(),
      new GraphPinningDependencyResolver(),
      blobs
    );
    const result = {
      nodeResults: {
        [node.id]: { nodeId: node.id, inputs: {}, outputs: { file: { ...PDF, id } } },
      },
      metadata: {},
    } as unknown as GraphExecutionResult;
    await pinning.pinNode({
      document: resolved.document ?? (resolved as never),
      plan,
      result,
      nodeId: node.id,
      includeDependencies: false,
    });

    expect(await service.pruneRuns(NOW)).toEqual(["pinned-run"]);
    expect(await blobs.read(id)).toEqual(Buffer.from("keep"));
    expect(await blobs.belongsTo("pinned-run", id)).toBe(false);

    const key = pinning.createValueKey(
      (resolved.document ?? (resolved as never as { id: string })).id,
      node,
      {},
      {}
    );
    await pinning.unpinNode({
      document: resolved.document ?? (resolved as never),
      nodeId: node.id,
      fingerprint: key.fingerprint,
    });
    expect(serializeGraphValueKey(key)).toContain(node.id);
    expect(await blobs.read(id)).toBeUndefined();
    service.dispose();
  });
});

describe("nested runs record their files under the top-level run", () => {
  it("a loop body's files belong to the root run and go with it", async () => {
    const { document, edge, node, port } = await import("../../../../src/workflows/builders");
    const body = document({
      id: "nested-binary-body",
      name: "nested-binary-body",
      inputs: [port("item")],
      outputs: [port("result")],
      nodes: [node("toFile", "core.io.convertToFile", { operation: "toJson", fileName: "item.json" })],
      edges: [
        edge("b1", ["workflow", "item"], ["node", "toFile", "value"]),
        edge("b2", ["node", "toFile", "result"], ["workflow", "result"]),
      ],
    });
    const parent = document({
      id: "nested-binary-parent",
      name: "nested-binary-parent",
      inputs: [port("items")],
      outputs: [port("files")],
      nodes: [
        node("each", "core.loop.foreach", { itemPort: "item", resultPort: "result" }, { loop: { body } }),
      ],
      edges: [
        edge("p1", ["workflow", "items"], ["node", "each", "items"]),
        edge("p2", ["node", "each", "completed"], ["workflow", "files"]),
      ],
    });
    const store = new BlobGraphBinaryStore(await memoryBlobs(), { deleteGraceMs: 0 });
    const { engine, catalogue } = await bootFixtureEngine({ binaryStore: store });
    await resolveDocument(parent, catalogue);
    const result = await engine.execute(parent, { items: [{ n: 1 }, { n: 2 }] });
    expect(result.status).toBe("succeeded");

    const ids = graphBinaryIdsOf(result.outputs["files"]);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(await store.belongsTo(result.runId, id)).toBe(true);
    }
    // Releasing the top-level run leaves nothing behind (no orphaned
    // per-iteration holders).
    await store.deleteRun(result.runId);
    for (const id of ids) expect(await store.read(id)).toBeUndefined();
    const leftovers = await store.service.list({});
    expect(leftovers.items).toEqual([]);
  });
});
