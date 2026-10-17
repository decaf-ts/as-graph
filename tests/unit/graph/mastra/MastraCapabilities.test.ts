/**
 * @module as-graph/tests/unit/graph/mastra/MastraCapabilities
 * @summary SAA-346 unit evidence: the Mastra workflow-management capability rows
 * and the three-valued management projection.
 * @description Real-vs-injected note. **Real**: the production
 * `MASTRA_FEATURE_CAPABILITIES` table, `mastraCapabilityOf`,
 * `mastraCapabilityStatusOf`, `resolveMastraCapabilities`, and the production
 * backend's declared `capabilities`. Nothing is stubbed.
 */
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import {
  MASTRA_FEATURE_CAPABILITIES,
  mastraCapabilityOf,
  mastraCapabilityStatusOf,
  resolveMastraCapabilities,
} from "../../../../src/mastra/MastraCapabilities";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";

/** The SAA-346 management rows and their honest verdicts. */
const MANAGEMENT_ROWS: Array<[string, string]> = [
  ["workflowCreate", "SUPPORTED"],
  ["workflowUpdate", "SUPPORTED"],
  ["workflowDelete", "SUPPORTED"],
  ["workflowRegistryList", "SUPPORTED"],
  ["workflowRegistryLookup", "SUPPORTED"],
  ["workflowSerialize", "SUPPORTED"],
  ["workflowPersist", "NOT-SUPPORTED"],
  ["workflowVersion", "EXTENSION-POINT"],
];

describe("Mastra workflow-management capabilities (SAA-346)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("exports every new management row with its honest verdict", () => {
    for (const [feature, verdict] of MANAGEMENT_ROWS) {
      const row = mastraCapabilityOf(feature);
      expect(row).toBeDefined();
      expect(row!.verdict).toBe(verdict);
      expect(MASTRA_FEATURE_CAPABILITIES.map((entry) => entry.feature)).toContain(
        feature
      );
    }
  });

  it("maps each management verdict onto the three-valued status", () => {
    expect(mastraCapabilityStatusOf("workflowCreate")).toBe("supported");
    expect(mastraCapabilityStatusOf("workflowUpdate")).toBe("supported");
    expect(mastraCapabilityStatusOf("workflowDelete")).toBe("supported");
    expect(mastraCapabilityStatusOf("workflowSerialize")).toBe("supported");
    expect(mastraCapabilityStatusOf("workflowPersist")).toBe("not_supported");
    expect(mastraCapabilityStatusOf("workflowVersion")).toBe("extension_point");
  });

  it("resolves the management statuses in the backend capability projection", () => {
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

  it("exports the read-only metrics capability rows with honest verdicts", () => {
    for (const [feature, verdict] of [
      ["metricsRuns", "SUPPORTED"],
      ["metricsScores", "SUPPORTED"],
      ["metricsTraces", "SUPPORTED"],
    ] as Array<[string, string]>) {
      const row = mastraCapabilityOf(feature);
      expect(row).toBeDefined();
      expect(row!.verdict).toBe(verdict);
      expect(
        MASTRA_FEATURE_CAPABILITIES.map((entry) => entry.feature)
      ).toContain(feature);
    }
  });

  it("exports the SAA-836 M6 trigger/voice/builder rows with honest verdicts", () => {
    for (const [feature, verdict] of [
      ["scheduleTrigger", "SUPPORTED"],
      ["channelTriggers", "EXTENSION-POINT"],
      ["channelResponses", "EXTENSION-POINT"],
      ["voice", "EXTENSION-POINT"],
      ["agentToolBuilders", "SUPPORTED"],
      ["runtimeEngineLoading", "SUPPORTED"],
    ] as Array<[string, string]>) {
      const row = mastraCapabilityOf(feature);
      expect({ feature, defined: row !== undefined }).toEqual({
        feature,
        defined: true,
      });
      expect(row!.verdict).toBe(verdict);
      expect(
        MASTRA_FEATURE_CAPABILITIES.map((entry) => entry.feature)
      ).toContain(feature);
    }
  });

  it("projects the backend capabilities as exactly resolveMastraCapabilities()", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });

    expect(backend.capabilities).toEqual(resolveMastraCapabilities());
    expect(backend.capabilities.workflows.create).toBe("supported");
    expect(backend.capabilities.workflows.update).toBe("supported");
    expect(backend.capabilities.workflows.delete).toBe("supported");
    expect(backend.capabilities.workflows.serialize).toBe("supported");
    expect(backend.capabilities.workflows.persist).toBe("not_supported");
    expect(backend.capabilities.workflows.version).toBe("extension_point");
  });
});
