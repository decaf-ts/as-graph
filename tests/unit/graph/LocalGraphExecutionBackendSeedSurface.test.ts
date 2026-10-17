/**
 * @module as-graph/tests/unit/graph/LocalGraphExecutionBackendSeedSurface.test
 * @summary SAA-804 (from SAA-798) F2 verification: `LocalGraphExecutionBackend`
 * prefers a store's tolerant `seedDocument` surface over the fail-closed
 * `saveDocument` write path, skips a foreign-owned id, and still seeds the rest;
 * a store that exposes only `saveDocument` falls back to it.
 * @description Behavioural checks over the `GraphBackendWorkflowStore` port:
 * - F2.3a store exposing `seedDocument` → it is used for every document,
 *   `saveDocument` is never called, a `null` result (foreign-owned skip) is
 *   omitted from the seeded summaries while the rest are returned;
 * - F2.3b store exposing only `saveDocument` → it is used for every document
 *   (the pre-existing fallback, unchanged).
 */
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import type { GraphBackendWorkflowStore } from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import {
  LocalGraphExecutionBackend,
  type LocalGraphExecutionBackendConfig,
} from "../../../src/engine/execution/LocalGraphExecutionBackend";

import { linearDocument } from "./engine-fixtures";

/** A minimal canonical document with the given id (validation is the store's job). */
function documentOf(id: string): GraphWorkflowDocument {
  return { id, name: id, inputs: [], outputs: [], nodes: [], edges: [] };
}

/**
 * Boots a local backend wired with the given workflow store. `seedWorkflows`
 * touches neither the adapter nor the engine, so minimal stand-ins suffice.
 */
async function backendWithStore(
  workflowStore: GraphBackendWorkflowStore
): Promise<LocalGraphExecutionBackend> {
  const backend = new LocalGraphExecutionBackend();
  const config = {
    valueAdapter: {} as never,
    engine: {} as never,
    workflowStore,
  } as LocalGraphExecutionBackendConfig;
  await backend.initialize(config);
  return backend;
}

describe("LocalGraphExecutionBackend.seedWorkflows seed-surface preference (SAA-798 F2)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("F2.3a prefers seedDocument, skips a foreign-owned id (null) and still seeds the rest", async () => {
    const seedDocument = jest.fn(async (id: string) =>
      id === "foreign-owned" ? null : { workflowId: id }
    );
    const saveDocument = jest.fn(async () => ({}));
    const backend = await backendWithStore({
      listWorkflows: async () => [],
      getDocument: async () => linearDocument(),
      seedDocument: seedDocument as never,
      saveDocument: saveDocument as never,
    });
    const documents = [documentOf("foreign-owned"), documentOf("ok")];

    const summaries = await backend.seedWorkflows(documents);

    expect(seedDocument).toHaveBeenCalledTimes(2);
    expect(seedDocument).toHaveBeenCalledWith("foreign-owned", documents[0]);
    expect(seedDocument).toHaveBeenCalledWith("ok", documents[1]);
    // The plain write path is never used when the tolerant seed surface exists.
    expect(saveDocument).not.toHaveBeenCalled();
    // The skipped foreign id is omitted; the rest are seeded.
    expect(summaries.map((summary) => summary.id)).toEqual(["ok"]);
  });

  it("F2.3b falls back to saveDocument when the store exposes no seedDocument", async () => {
    const saveDocument = jest.fn(async () => ({}));
    const store: GraphBackendWorkflowStore = {
      listWorkflows: async () => [],
      getDocument: async () => linearDocument(),
      saveDocument: saveDocument as never,
    };
    expect(store.seedDocument).toBeUndefined();

    const backend = await backendWithStore(store);
    const documents = [documentOf("one"), documentOf("two")];

    const summaries = await backend.seedWorkflows(documents);

    expect(saveDocument).toHaveBeenCalledTimes(2);
    expect(saveDocument).toHaveBeenCalledWith("one", documents[0]);
    expect(saveDocument).toHaveBeenCalledWith("two", documents[1]);
    expect(summaries.map((summary) => summary.id)).toEqual(["one", "two"]);
  });
});
