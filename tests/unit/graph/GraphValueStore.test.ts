/**
 * @module as-graph/tests/unit/graph/GraphValueStore.test
 * @summary Unit tests for the graph value store and in-memory adapter.
 */
import { GRAPH_WORKFLOW_BOUNDARY } from "../../../src/engine/constants";
import { InMemoryGraphValueStoreAdapter } from "../../../src/engine/store/InMemoryGraphValueStoreAdapter";
import { GraphValueStore } from "../../../src/engine/store/GraphValueStore";
import type { GraphValueKey } from "../../../src/engine/store/GraphValueKey";

describe("InMemoryGraphValueStoreAdapter", () => {
  function key(nodeId: string, fingerprint = "fp"): GraphValueKey {
    return { workflowId: "wf", nodeId, fingerprint };
  }

  it("writes and reads back a cached value", async () => {
    const adapter = new InMemoryGraphValueStoreAdapter();
    const cached = {
      key: key("n1"),
      outputs: { x: 1 },
      pinned: false,
      createdAt: "now",
      updatedAt: "now",
    };
    await adapter.write(key("n1"), cached);
    const result = await adapter.read(key("n1"));
    expect(result).toEqual(cached);
  });

  it("returns undefined for a missing key", async () => {
    const adapter = new InMemoryGraphValueStoreAdapter();
    expect(await adapter.read(key("missing"))).toBeUndefined();
  });

  it("has returns true after write, false after delete", async () => {
    const adapter = new InMemoryGraphValueStoreAdapter();
    await adapter.write(key("n1"), {
      key: key("n1"),
      outputs: {},
      pinned: false,
      createdAt: "",
      updatedAt: "",
    });
    expect(await adapter.has(key("n1"))).toBe(true);
    await adapter.delete(key("n1"));
    expect(await adapter.has(key("n1"))).toBe(false);
  });

  it("list filters by workflowId and nodeId prefix", async () => {
    const adapter = new InMemoryGraphValueStoreAdapter();
    const k1 = key("n1", "a");
    const k2 = { ...key("n2", "b"), workflowId: "other" };
    await adapter.write(k1, {
      key: k1,
      outputs: {},
      pinned: false,
      createdAt: "",
      updatedAt: "",
    });
    await adapter.write(k2, {
      key: k2,
      outputs: {},
      pinned: false,
      createdAt: "",
      updatedAt: "",
    });

    const byWf = await adapter.list({ workflowId: "wf" });
    expect(byWf).toHaveLength(1);
    expect(byWf[0].key.nodeId).toBe("n1");

    const byNode = await adapter.list({ nodeId: "n2" });
    expect(byNode).toHaveLength(1);
  });

  it("clearRun removes all values", async () => {
    const adapter = new InMemoryGraphValueStoreAdapter();
    await adapter.write(key("n1"), {
      key: key("n1"),
      outputs: {},
      pinned: false,
      createdAt: "",
      updatedAt: "",
    });
    await adapter.clearRun("r1");
    expect(await adapter.has(key("n1"))).toBe(false);
  });
});

describe("GraphValueStore", () => {
  it("seedWorkflowInputs stores inputs under the boundary key", () => {
    const store = new GraphValueStore(new InMemoryGraphValueStoreAdapter());
    store.seedWorkflowInputs({ a: 1, b: 2 });
    expect(store.getPort(GRAPH_WORKFLOW_BOUNDARY, "a")).toBe(1);
    expect(store.hasPort(GRAPH_WORKFLOW_BOUNDARY, "b")).toBe(true);
  });

  it("setNodeOutputs and getPort retrieve values", () => {
    const store = new GraphValueStore(new InMemoryGraphValueStoreAdapter());
    store.setNodeOutputs("n1", { sum: 3 });
    expect(store.getPort("n1", "sum")).toBe(3);
    expect(store.hasPort("n1", "missing")).toBe(false);
  });

  it("setWorkflowOutput merges into boundary values", () => {
    const store = new GraphValueStore(new InMemoryGraphValueStoreAdapter());
    store.seedWorkflowInputs({ a: 1 });
    store.setWorkflowOutput("result", 42);
    const values = store.getWorkflowValues();
    expect(values.a).toBe(1);
    expect(values.result).toBe(42);
  });

  it("snapshot returns a record of all runtime values", () => {
    const store = new GraphValueStore(new InMemoryGraphValueStoreAdapter());
    store.seedWorkflowInputs({ a: 1 });
    store.setNodeOutputs("n1", { sum: 3 });
    const snap = store.snapshot();
    expect(snap[GRAPH_WORKFLOW_BOUNDARY].a).toBe(1);
    expect(snap.n1.sum).toBe(3);
  });

  it("delegates cached read/write/delete to the adapter", async () => {
    const adapter = new InMemoryGraphValueStoreAdapter();
    const store = new GraphValueStore(adapter);
    const k: GraphValueKey = { workflowId: "wf", nodeId: "n1", fingerprint: "fp" };
    await store.writeCached(k, {
      key: k,
      outputs: { x: 1 },
      pinned: true,
      createdAt: "",
      updatedAt: "",
    });
    const read = await store.readCached(k);
    expect(read?.pinned).toBe(true);
    await store.deleteCached(k);
    expect(await store.readCached(k)).toBeUndefined();
  });

  it("getAdapter returns the underlying adapter", () => {
    const adapter = new InMemoryGraphValueStoreAdapter();
    const store = new GraphValueStore(adapter);
    expect(store.getAdapter()).toBe(adapter);
  });
});
