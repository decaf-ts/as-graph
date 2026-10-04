/**
 * @module as-graph/tests/unit/graph/mastra/MastraGraphExecutionBackend
 * @summary Driver tests for `MastraGraphExecutionBackend` (SAA-201 cases 6, 7).
 * @description Proves the backend's seam contract (`local`/`codeMode`), the
 * capability metadata, and workflow listing/lookup over the translated cache.
 */
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import {
  MASTRA_FEATURE_CAPABILITIES,
  mastraCapabilityOf,
  resolveMastraCapabilities,
} from "../../../../src/mastra/MastraCapabilities";
import {
  GRAPH_MASTRA_UNSUPPORTED_KIND,
  MASTRA_BACKEND_FLAVOUR,
} from "../../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";
import { frameBoundSink, humanApprovalDocument } from "./helpers";

describe("MastraGraphExecutionBackend", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("declares the translated-backend seam contract", () => {
    const backend = new MastraGraphExecutionBackend();

    expect(backend.local).toBe(false);
    expect(backend.codeMode).toBe("unsupported");
    expect(backend.capabilities).toEqual({
      codeMode: "unsupported",
      workflows: { list: "supported", get: "supported" },
    });
    expect(GraphExecutionBackendRegistry.get(MASTRA_BACKEND_FLAVOUR)).toBe(backend);
  });

  it("exposes every workflow capability row without silent omission", () => {
    expect(mastraCapabilityOf("workflowList")).toBeDefined();
    expect(mastraCapabilityOf("workflowLookup")).toBeDefined();
    expect(mastraCapabilityOf("workflowList")!.verdict).toBe("SUPPORTED");
    expect(mastraCapabilityOf("workflowLookup")!.verdict).toBe("SUPPORTED");
    expect(
      MASTRA_FEATURE_CAPABILITIES.map((row) => row.feature)
    ).toEqual(
      expect.arrayContaining(["workflowList", "workflowLookup"])
    );
    expect(resolveMastraCapabilities()).toEqual({
      codeMode: "unsupported",
      workflows: { list: "supported", get: "supported" },
    });
  });

  it("lists and looks up a translated workflow after execute compiles it", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });
    const { sink } = frameBoundSink();
    const source = humanApprovalDocument();

    const result = await backend.execute({
      document: source,
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: sink,
    });

    expect(result.workflowId).toBe(source.id);
    const summaries = await backend.listWorkflows();
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: source.id, name: source.name }),
      ])
    );
    expect((await backend.getWorkflow(source.id)).id).toBe(source.id);
  });

  it("throws GRAPH_MASTRA_UNSUPPORTED_KIND for an unknown workflow id", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });

    await expect(backend.getWorkflow("missing")).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_UNSUPPORTED_KIND,
    });
  });

  it("requires the frame-bound event sink created by the facade", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });

    await expect(
      backend.execute({
        document: humanApprovalDocument(),
        plan: {} as never,
        inputs: {},
        options: {} as never,
        events: {
          emit: async () => {},
          updateObservers: async () => {},
        },
      })
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_UNSUPPORTED_KIND });
  });

  it("fails resume closed when no suspendStateReader is configured", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });

    await expect(backend.resume("run-1", { step: "approve" })).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_UNSUPPORTED_KIND,
    });
  });

  it("clears translated documents on dispose()", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });
    const { sink } = frameBoundSink();
    await backend.execute({
      document: humanApprovalDocument(),
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: sink,
    });
    expect((await backend.listWorkflows()).length).toBe(1);

    await backend.dispose();

    expect(await backend.listWorkflows()).toEqual([]);
  });

});
