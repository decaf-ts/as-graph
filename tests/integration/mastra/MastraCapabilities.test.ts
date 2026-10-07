/**
 * @module as-graph/tests/integration/mastra/MastraCapabilities.test
 * @summary SAA-307 evidence: the Mastra capability projection and the exported
 * feature table, resolved through both the backend and the engine.
 * @description Real-vs-injected note. **Real**: the production
 * `MASTRA_FEATURE_CAPABILITIES` table, `resolveMastraCapabilities`,
 * `mastraCapabilityOf`, the backend's declared `capabilities`, and the engine's
 * capability projection. Nothing is stubbed; the backend is the production one.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import {
  MASTRA_FEATURE_CAPABILITIES,
  mastraCapabilityOf,
  resolveMastraCapabilities,
} from "../../../src/mastra/MastraCapabilities";
import { MASTRA_BACKEND_FLAVOUR } from "../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { resolveGraphBackendCapabilities } from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { bootEngine, demoCatalogue } from "../../unit/graph/engine-fixtures";
import { realStepHandler } from "./helpers";

describe("Mastra capabilities (SAA-307 item 4)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("projects the backend capabilities from the exported table", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });

    expect(backend.capabilities).toEqual(resolveMastraCapabilities());
    expect(backend.capabilities).toEqual({
      codeMode: "unsupported",
      workflows: { list: "supported", get: "supported" },
    });
    expect(backend.codeMode).toBe("unsupported");
    expect(backend.local).toBe(false);
    expect(resolveGraphBackendCapabilities(backend)).toEqual(
      backend.capabilities
    );
  });

  it("declares the honest feature verdicts without silent omission", () => {
    expect(MASTRA_FEATURE_CAPABILITIES.length).toBeGreaterThan(0);
    for (const row of MASTRA_FEATURE_CAPABILITIES) {
      expect(typeof row.feature).toBe("string");
      expect(row.feature.length).toBeGreaterThan(0);
      expect(["SUPPORTED", "NOT-SUPPORTED", "EXTENSION-POINT", "PARTIAL"]).toContain(
        row.verdict
      );
    }
    expect(mastraCapabilityOf("parallel")?.verdict).toBe("NOT-SUPPORTED");
    expect(mastraCapabilityOf("pinning")?.verdict).toBe("NOT-SUPPORTED");
    expect(mastraCapabilityOf("workflowList")?.verdict).toBe("SUPPORTED");
    expect(mastraCapabilityOf("workflowLookup")?.verdict).toBe("SUPPORTED");
    expect(mastraCapabilityOf("suspendResume")?.verdict).toBe("EXTENSION-POINT");
    expect(mastraCapabilityOf("humanApproval")?.verdict).toBe("SUPPORTED");
    expect(mastraCapabilityOf("does-not-exist")).toBeUndefined();
  });

  it("resolves the engine's backend capabilities from the registered backend", async () => {
    const catalogue = await demoCatalogue({ "test.leaf": { execute: () => ({}) } });
    const backend = new MastraGraphExecutionBackend();
    const engine = await bootEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
      catalogue,
      backend,
    });
    await backend.initialize({
      mastra: {},
      stepHandlers: [realStepHandler("test.leaf")],
    });

    expect(GraphExecutionBackendRegistry.get(MASTRA_BACKEND_FLAVOUR)).toBe(backend);
    expect(engine.backendCapabilities).toEqual(resolveMastraCapabilities());
    expect(engine.backendCapabilities.workflows.list).toBe("supported");
    expect(engine.backendCapabilities.workflows.get).toBe("supported");
    expect(engine.backendCapabilities.codeMode).toBe("unsupported");
  });
});
