/**
 * @module as-graph/tests/unit/graph/mastra/MastraStorageWiring
 * @summary SAA-926 §6.2 acceptance: the host-declared Mastra storage is wired
 * onto the runtime and verified, and a non-durable workflows domain fails
 * closed instead of silently persisting in memory.
 * @description Real: the production `wireMastraStorage` /
 * `resolveMastraStorageDomainStatus` and the production
 * `MastraGraphExecutionBackend.storageStatus` seam, driven through real
 * `Mastra` and `InMemoryStore` instances. Fake: only the durable/composite
 * storage boundary (a storage whose workflows domain is a non-in-memory store),
 * because a real durable (`@mastra/pg`) store requires a live Postgres and is
 * covered by `tests/integration/graph/TypeormGraphAdapterPostgres`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import {
  resolveMastraStorageDomainStatus,
  wireMastraStorage,
} from "../../../../src/mastra/MastraStorageWiring";
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";
import {
  GRAPH_MASTRA_STORAGE_DOMAIN_INMEMORY,
  GRAPH_MASTRA_STORAGE_UNWIRED,
} from "../../../../src/mastra/types";

const OBSERVABILITY_ENABLED_OVERRIDE = "MASTRA__OBSERVABILITY__ENABLED";
let observabilityEnabledOriginal: string | undefined;

beforeAll(() => {
  observabilityEnabledOriginal = process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  process.env[OBSERVABILITY_ENABLED_OVERRIDE] = "false";
});

afterAll(() => {
  if (observabilityEnabledOriginal === undefined) {
    delete process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  } else {
    process.env[OBSERVABILITY_ENABLED_OVERRIDE] = observabilityEnabledOriginal;
  }
});

afterEach(() => {
  GraphExecutionBackendRegistry.clear();
});

/** A durable workflows store boundary: not an in-memory store class. */
function durableWorkflowsStore(): Record<string, unknown> {
  return {
    getWorkflowRunById: async () => undefined,
    persistWorkflowSnapshot: async () => undefined,
  };
}

/** A composite storage whose workflows domain is the given store. */
function compositeStorage(workflows: unknown): Record<string, unknown> {
  return {
    getStore: async (domain: string) =>
      domain === "workflows" ? workflows : undefined,
  };
}

/** A runtime whose `setStorage` stores the very object it was handed. */
function recordingRuntime(): Record<string, unknown> {
  const runtime: Record<string, unknown> = {
    storage: undefined,
    setStorage(storage: unknown) {
      runtime["storage"] = storage;
    },
    getStorage() {
      return runtime["storage"];
    },
  };
  return runtime;
}

describe("resolveMastraStorageDomainStatus (SAA-926 §6.2)", () => {
  it("reports absent when the runtime exposes no storage surface", async () => {
    await expect(resolveMastraStorageDomainStatus({})).resolves.toEqual({
      workflows: "absent",
    });
  });

  it("reports absent when getStorage resolves nothing", async () => {
    await expect(
      resolveMastraStorageDomainStatus({ getStorage: async () => undefined })
    ).resolves.toEqual({ workflows: "absent" });
  });

  it("reports absent when the workflows store does not resolve", async () => {
    const runtime = {
      getStorage: async () => ({ getStore: async () => undefined }),
    };
    await expect(resolveMastraStorageDomainStatus(runtime)).resolves.toEqual({
      workflows: "absent",
    });
  });

  it("reports in-memory for a real InMemoryStore workflows domain", async () => {
    const runtime = new Mastra({ storage: new InMemoryStore() });
    await expect(resolveMastraStorageDomainStatus(runtime)).resolves.toEqual({
      workflows: "in-memory",
    });
  });

  it("reports durable for a non-in-memory workflows domain", async () => {
    const runtime = {
      getStorage: async () => compositeStorage(durableWorkflowsStore()),
    };
    await expect(resolveMastraStorageDomainStatus(runtime)).resolves.toEqual({
      workflows: "durable",
    });
  });
});

describe("wireMastraStorage (SAA-926 §6.2)", () => {
  it("rejects a declared storage when the runtime is not a Mastra record", async () => {
    await expect(
      wireMastraStorage(undefined, new InMemoryStore())
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_STORAGE_UNWIRED });
  });

  it("rejects a declared storage when the runtime exposes no setStorage surface", async () => {
    await expect(
      wireMastraStorage({ getStorage: async () => undefined }, new InMemoryStore())
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_STORAGE_UNWIRED });
  });

  it("rejects when the declared storage does not take effect after setStorage", async () => {
    const runtime = { setStorage: async () => undefined };

    await expect(
      wireMastraStorage(runtime, durableWorkflowsStore())
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_STORAGE_UNWIRED });
  });

  it("accepts an explicitly wired InMemoryStore for dev/test hosts", async () => {
    const runtime = new Mastra({});
    const storage = new InMemoryStore();

    const status = await wireMastraStorage(runtime, storage);

    expect(status).toEqual({
      wired: true,
      explicitInMemory: true,
      domains: { workflows: "in-memory" },
    });
    expect(runtime.getStorage()).toBeDefined();
  });

  it("accepts a durable storage whose workflows domain resolves", async () => {
    const workflows = durableWorkflowsStore();
    const storage = compositeStorage(workflows);
    const runtime = recordingRuntime();

    const status = await wireMastraStorage(runtime, storage);

    expect(status).toEqual({
      wired: true,
      explicitInMemory: false,
      domains: { workflows: "durable" },
    });
    expect(runtime["storage"]).toBe(storage);
  });

  it("rejects a composite storage that silently misses the workflows domain", async () => {
    const realInMemory = new InMemoryStore();
    const storage = compositeStorage(await realInMemory.getStore("workflows"));
    const runtime = recordingRuntime();

    await expect(wireMastraStorage(runtime, storage)).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_STORAGE_DOMAIN_INMEMORY,
    });
  });

  it("rejects a storage with no workflows domain at all", async () => {
    const runtime = recordingRuntime();

    await expect(
      wireMastraStorage(runtime, compositeStorage(undefined))
    ).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_STORAGE_DOMAIN_INMEMORY,
    });
  });
});

describe("MastraGraphExecutionBackend.storageStatus (SAA-926 §6.2)", () => {
  it("is undefined when the host declares no storage config", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });

    expect(backend.storageStatus).toBeUndefined();
  });

  it("exposes the resolved status for an explicit InMemoryStore host", async () => {
    const runtime = new Mastra({});
    const backend = new MastraGraphExecutionBackend();

    await backend.initialize({ mastra: runtime, storage: new InMemoryStore() });

    expect(backend.storageStatus).toEqual({
      wired: true,
      explicitInMemory: true,
      domains: { workflows: "in-memory" },
    });
  });

  it("exposes a durable status for a durable workflows domain", async () => {
    const backend = new MastraGraphExecutionBackend();

    await backend.initialize({
      mastra: recordingRuntime(),
      storage: compositeStorage(durableWorkflowsStore()),
    });

    expect(backend.storageStatus).toEqual({
      wired: true,
      explicitInMemory: false,
      domains: { workflows: "durable" },
    });
  });

  it("fails initialize closed when the runtime cannot accept the storage", async () => {
    const backend = new MastraGraphExecutionBackend();

    await expect(
      backend.initialize({ mastra: {}, storage: new InMemoryStore() })
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_STORAGE_UNWIRED });
    expect(backend.storageStatus).toBeUndefined();
  });

  it("fails initialize closed when the wired workflows domain is in-memory", async () => {
    const realInMemory = new InMemoryStore();
    const backend = new MastraGraphExecutionBackend();

    await expect(
      backend.initialize({
        mastra: recordingRuntime(),
        storage: compositeStorage(await realInMemory.getStore("workflows")),
      })
    ).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_STORAGE_DOMAIN_INMEMORY,
    });
  });
});
