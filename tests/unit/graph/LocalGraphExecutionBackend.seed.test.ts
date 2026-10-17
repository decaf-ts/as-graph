/**
 * @module as-graph/tests/unit/graph/LocalGraphExecutionBackend.seed.test
 * @summary Fail-closed and happy-path coverage for
 * `LocalGraphExecutionBackend.seedWorkflows` (SAA-802, from SAA-799).
 * @description DECAF-50 §4.9: the local reference backend seeds canonical
 * workflow documents through its wired `GraphWorkflowStore` port's own write
 * path (`saveDocument`), never a bypass. A read-only (or absent) store must fail
 * closed with `GRAPH_BACKEND_SEED_NOT_SUPPORTED` rather than silently dropping
 * the seeds. Only the happy path is covered elsewhere; this suite pins both
 * unwritable shapes and the persisting path.
 */
import type { GraphBackendWorkflowStore } from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import {
  LocalGraphExecutionBackend,
  type LocalGraphExecutionBackendConfig,
} from "../../../src/engine/execution/LocalGraphExecutionBackend";

import { linearDocument } from "./engine-fixtures";

/**
 * Boots a local backend with the given workflow store (or none), using minimal
 * facade collaborators — `seedWorkflows` touches neither the adapter nor the
 * engine, so stand-ins suffice for these unit cases.
 */
async function backendWithStore(
  workflowStore?: GraphBackendWorkflowStore
): Promise<LocalGraphExecutionBackend> {
  const backend = new LocalGraphExecutionBackend();
  const config = {
    valueAdapter: {} as never,
    engine: {} as never,
    ...(workflowStore ? { workflowStore } : {}),
  } as LocalGraphExecutionBackendConfig;
  await backend.initialize(config);
  return backend;
}

describe("LocalGraphExecutionBackend.seedWorkflows — fail-closed (SAA-802)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("fails closed with GRAPH_BACKEND_SEED_NOT_SUPPORTED when no store is wired", async () => {
    const backend = await backendWithStore();

    await expect(backend.seedWorkflows([linearDocument()])).rejects.toMatchObject({
      graphCode: "GRAPH_BACKEND_SEED_NOT_SUPPORTED",
    });
  });

  it("fails closed when the wired store omits the saveDocument write path", async () => {
    const store: GraphBackendWorkflowStore = {
      listWorkflows: async () => [],
      getDocument: async () => linearDocument(),
    };
    expect(store.saveDocument).toBeUndefined();

    const backend = await backendWithStore(store);

    await expect(backend.seedWorkflows([linearDocument()])).rejects.toMatchObject({
      graphCode: "GRAPH_BACKEND_SEED_NOT_SUPPORTED",
    });
  });

  it("persists through the store's own saveDocument and returns the summaries", async () => {
    const saveDocument = jest.fn(async () => undefined);
    const backend = await backendWithStore({
      listWorkflows: async () => [],
      getDocument: async () => linearDocument(),
      saveDocument,
    });
    const documents = [linearDocument()];

    const summaries = await backend.seedWorkflows(documents);

    expect(saveDocument).toHaveBeenCalledTimes(1);
    expect(saveDocument).toHaveBeenCalledWith("linear-wf", documents[0]);
    expect(summaries).toEqual([{ id: "linear-wf", name: "linear-wf" }]);
  });
});
