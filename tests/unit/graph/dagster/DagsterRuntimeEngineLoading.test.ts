/**
 * @module as-graph/tests/unit/graph/dagster/DagsterRuntimeEngineLoading
 * @summary Unit tests for the SAA-836 M6 runtime engine loading, dagster side.
 * @description Proves a consumer booting the dagster engine variant never loads
 * the mastra backend module: the host builds the dagster backend through a
 * runtime dynamic import, the mastra backend module is jest-blocked (loading
 * it fails the suite), and only the `dagster` flavour registers on the backend
 * registry. The reverse direction (mastra without dagster) is pinned by the
 * mastra-side sibling suite.
 */
import { jest, describe, it, expect, afterEach } from "@jest/globals";
import { createGraphBackendHost } from "../../../../src/nest/graph/GraphBackendHost";
import {
  DagsterGraphExecutionBackend,
} from "../../../../src/dagster/DagsterGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";

// The mastra engine backend must never load for a dagster consumer: loading
// the module (and constructing its backend) fails this suite outright.
jest.mock("../../../../src/mastra/MastraGraphExecutionBackend", () => {
  throw new Error(
    "the mastra backend module must not load for the dagster engine variant"
  );
});

describe("dagster runtime engine loading (SAA-836 M6)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("builds the dagster backend through the runtime dynamic import", async () => {
    const host = await createGraphBackendHost({ variant: "dagster" });

    expect(host.variant).toBe("dagster");
    expect(host.engineId).toBe("dagster");
    expect(host.backend).toBeInstanceOf(DagsterGraphExecutionBackend);
    expect(host.moduleOptions.engines?.defaultEngineId).toBe("dagster");
  });

  it("registers only the dagster flavour on the backend registry", async () => {
    const host = await createGraphBackendHost({ variant: "dagster" });

    expect(GraphExecutionBackendRegistry.list().map((e) => e.flavour)).toEqual([
      "dagster",
    ]);
    expect(GraphExecutionBackendRegistry.list()[0]?.backend).toBe(host.backend);
  });
});
