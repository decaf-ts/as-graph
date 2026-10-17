/**
 * @module as-graph/tests/unit/graph/mastra/MastraRuntimeEngineLoading
 * @summary Unit tests for the SAA-836 M6 runtime engine loading (the
 * `runtimeEngineLoading` capability row).
 * @description Proves a consumer booting the mastra engine variant never loads
 * the dagster backend module: the host builds the mastra backend through a
 * runtime dynamic import, the dagster backend module is jest-blocked (loading
 * it fails the suite), and only the `mastra` flavour registers on the backend
 * registry. The reverse direction (dagster without mastra) is pinned by the
 * dagster-side sibling suite.
 */
import { jest, describe, it, expect, afterEach } from "@jest/globals";
import { createGraphBackendHost } from "../../../../src/nest/graph/GraphBackendHost";
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";

// The dagster engine backend must never load for a mastra consumer: loading
// the module (and constructing its backend) fails this suite outright.
jest.mock("../../../../src/dagster/DagsterGraphExecutionBackend", () => {
  throw new Error(
    "the dagster backend module must not load for the mastra engine variant"
  );
});

describe("mastra runtime engine loading (SAA-836 M6)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("builds the mastra backend through the runtime dynamic import", async () => {
    const host = await createGraphBackendHost({
      variant: "mastra",
      mastra: { mastra: {} },
    });

    expect(host.variant).toBe("mastra");
    expect(host.engineId).toBe("mastra");
    expect(host.backend).toBeInstanceOf(MastraGraphExecutionBackend);
    expect(host.moduleOptions.engines?.defaultEngineId).toBe("mastra");
  });

  it("registers only the mastra flavour on the backend registry", async () => {
    const host = await createGraphBackendHost({
      variant: "mastra",
      mastra: { mastra: {} },
    });

    expect(GraphExecutionBackendRegistry.list().map((e) => e.flavour)).toEqual([
      "mastra",
    ]);
    expect(GraphExecutionBackendRegistry.list()[0]?.backend).toBe(host.backend);
  });

  it("passes the host mastra config through backend initialization", async () => {
    const host = await createGraphBackendHost({
      variant: "mastra",
      mastra: {
        mastra: {},
        stepHandlers: [],
      },
    });
    const backend = host.backend as MastraGraphExecutionBackend;
    // initialization wired the host config: the compiler is live and the
    // capabilities projection resolves
    expect(backend.capabilities.workflows.create).toBe("supported");
  });
});
