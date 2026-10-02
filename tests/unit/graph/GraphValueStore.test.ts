/**
 * @module as-graph/tests/unit/graph/GraphValueStore.test
 * @summary Unit tests for the adapter-backed graph value repository.
 * @description The former in-memory value store adapter is superseded by
 * {@link GraphValueRepository}: cached/pinned values are persisted through the
 * configured Decaf adapter, while runtime values stay in-process.
 */
import { GRAPH_WORKFLOW_BOUNDARY } from "../../../src/engine/constants";
import {
  createGraphValueRepository,
  type GraphValueRepository,
} from "../../../src/engine/store/GraphValueRepository";
import { createRamGraphAdapter } from "../../../src/ram";
import type { GraphValueKey } from "../../../src/engine/store/GraphValueKey";
import type { GraphCachedValue } from "../../../src/engine/store/GraphCachedValue";

let adapterCounter = 0;

async function makeRepository(): Promise<GraphValueRepository> {
  const adapter = await createRamGraphAdapter(
    `graph-value-test-${adapterCounter++}`
  );
  return createGraphValueRepository(adapter as never);
}

function key(nodeId: string, fingerprint = "fp"): GraphValueKey {
  return { workflowId: "wf", nodeId, fingerprint };
}

function cachedValue(
  valueKey: GraphValueKey,
  extra: Partial<GraphCachedValue> = {}
): GraphCachedValue {
  const now = new Date().toISOString();
  return {
    key: valueKey,
    outputs: { x: 1 },
    pinned: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

describe("GraphValueRepository (adapter-backed)", () => {
  it("writes and reads back a cached value", async () => {
    const repository = await makeRepository();
    const valueKey = key("n1");
    await repository.writeCached(valueKey, cachedValue(valueKey));
    const result = await repository.readCached(valueKey);
    expect(result?.outputs).toEqual({ x: 1 });
    expect(result?.pinned).toBe(false);
    expect(result?.key).toEqual(valueKey);
  });

  it("returns undefined for a missing key", async () => {
    const repository = await makeRepository();
    expect(await repository.readCached(key("missing"))).toBeUndefined();
  });

  it("hasCached returns true after write, false after delete", async () => {
    const repository = await makeRepository();
    const valueKey = key("n1");
    await repository.writeCached(valueKey, cachedValue(valueKey));
    expect(await repository.hasCached(valueKey)).toBe(true);
    await repository.deleteCached(valueKey);
    expect(await repository.hasCached(valueKey)).toBe(false);
  });

  it("listCached filters by workflowId and nodeId prefix", async () => {
    const repository = await makeRepository();
    const k1 = key("n1", "a");
    const k2 = { ...key("n2", "b"), workflowId: "other" };
    await repository.writeCached(k1, cachedValue(k1));
    await repository.writeCached(k2, cachedValue(k2));

    const byWf = await repository.listCached({ workflowId: "wf" });
    expect(byWf).toHaveLength(1);
    expect(byWf[0].key.nodeId).toBe("n1");

    const byNode = await repository.listCached({ nodeId: "n2" });
    expect(byNode).toHaveLength(1);
  });

  it("clearRun removes all cached values", async () => {
    const repository = await makeRepository();
    const valueKey = key("n1");
    await repository.writeCached(valueKey, cachedValue(valueKey));
    await repository.clearRun("r1");
    expect(await repository.hasCached(valueKey)).toBe(false);
  });
});

describe("GraphValueRepository runtime values", () => {
  it("seedWorkflowInputs stores inputs under the boundary key", async () => {
    const repository = await makeRepository();
    repository.seedWorkflowInputs({ a: 1, b: 2 });
    expect(repository.getPort(GRAPH_WORKFLOW_BOUNDARY, "a")).toBe(1);
    expect(repository.hasPort(GRAPH_WORKFLOW_BOUNDARY, "b")).toBe(true);
  });

  it("setNodeOutputs and getPort retrieve values", async () => {
    const repository = await makeRepository();
    repository.setNodeOutputs("n1", { sum: 3 });
    expect(repository.getPort("n1", "sum")).toBe(3);
    expect(repository.hasPort("n1", "missing")).toBe(false);
  });

  it("setWorkflowOutput merges into boundary values", async () => {
    const repository = await makeRepository();
    repository.seedWorkflowInputs({ a: 1 });
    repository.setWorkflowOutput("result", 42);
    const values = repository.getWorkflowValues();
    expect(values.a).toBe(1);
    expect(values.result).toBe(42);
  });

  it("snapshot returns a record of all runtime values", async () => {
    const repository = await makeRepository();
    repository.seedWorkflowInputs({ a: 1 });
    repository.setNodeOutputs("n1", { sum: 3 });
    const snap = repository.snapshot();
    expect(snap[GRAPH_WORKFLOW_BOUNDARY].a).toBe(1);
    expect(snap.n1.sum).toBe(3);
  });

  it("readRuntimeValues and writeRuntimeValues round-trip node values", async () => {
    const repository = await makeRepository();
    repository.writeRuntimeValues("n1", { sum: 3 });
    expect(repository.readRuntimeValues("n1")).toEqual({ sum: 3 });
  });

  it("getAdapter returns the underlying adapter", async () => {
    const adapter = await createRamGraphAdapter(
      `graph-value-test-${adapterCounter++}`
    );
    const repository = createGraphValueRepository(adapter as never);
    expect(repository.getAdapter()).toBe(adapter);
  });
});
