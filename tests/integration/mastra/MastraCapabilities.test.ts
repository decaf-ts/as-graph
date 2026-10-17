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
  mastraCapabilityStatusOf,
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
    expect(backend.capabilities.workflows).toEqual({
      list: "supported",
      get: "supported",
      create: "supported",
      update: "supported",
      delete: "supported",
      serialize: "supported",
      persist: "not_supported",
      version: "extension_point",
    });
    expect(backend.codeMode).toBe("unsupported");
    expect(backend.local).toBe(false);
    // The engine-agnostic projection keeps only the two-valued list/get fields;
    // the management statuses are a Mastra-specific extension.
    expect(resolveGraphBackendCapabilities(backend)).toEqual({
      codeMode: "unsupported",
      workflows: { list: "supported", get: "supported" },
    });
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

  it("exports the SAA-346 management rows with their honest verdicts", () => {
    const rows: Array<[string, string]> = [
      ["workflowCreate", "SUPPORTED"],
      ["workflowUpdate", "SUPPORTED"],
      ["workflowDelete", "SUPPORTED"],
      ["workflowRegistryList", "SUPPORTED"],
      ["workflowRegistryLookup", "SUPPORTED"],
      ["workflowSerialize", "SUPPORTED"],
      ["workflowPersist", "NOT-SUPPORTED"],
      ["workflowVersion", "EXTENSION-POINT"],
    ];
    for (const [feature, verdict] of rows) {
      expect(mastraCapabilityOf(feature)?.verdict).toBe(verdict);
    }

    expect(mastraCapabilityStatusOf("workflowCreate")).toBe("supported");
    expect(mastraCapabilityStatusOf("workflowUpdate")).toBe("supported");
    expect(mastraCapabilityStatusOf("workflowDelete")).toBe("supported");
    expect(mastraCapabilityStatusOf("workflowSerialize")).toBe("supported");
    expect(mastraCapabilityStatusOf("workflowPersist")).toBe("not_supported");
    expect(mastraCapabilityStatusOf("workflowVersion")).toBe("extension_point");
  });

  it("resolves the SAA-346 management statuses in the projection", () => {
    expect(resolveMastraCapabilities()).toEqual({
      codeMode: "unsupported",
      workflows: {
        list: "supported",
        get: "supported",
        create: "supported",
        update: "supported",
        delete: "supported",
        serialize: "supported",
        persist: "not_supported",
        version: "extension_point",
      },
      metrics: {
        runs: "supported",
        scores: "supported",
        traces: "supported",
      },
    });
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
    // The engine projection is engine-agnostic: only the two-valued list/get
    // fields survive. The Mastra-specific management statuses live on the
    // backend's declared capabilities.
    expect(engine.backendCapabilities).toEqual({
      codeMode: "unsupported",
      workflows: { list: "supported", get: "supported" },
    });
    expect(engine.backendCapabilities.workflows.list).toBe("supported");
    expect(engine.backendCapabilities.workflows.get).toBe("supported");
    expect(engine.backendCapabilities.codeMode).toBe("unsupported");
    expect(backend.capabilities).toEqual(resolveMastraCapabilities());
    expect(backend.capabilities.workflows.create).toBe("supported");
    expect(backend.capabilities.workflows.persist).toBe("not_supported");
    expect(backend.capabilities.workflows.version).toBe("extension_point");
  });
});
