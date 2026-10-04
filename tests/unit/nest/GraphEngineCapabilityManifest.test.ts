/**
 * @module as-graph/tests/unit/nest/GraphEngineCapabilityManifest.test
 * @summary SAA-197 verification for the C20 engine capability manifest builder
 * (`src/nest/graph/GraphEngineCapabilityManifest.ts`).
 * @description Pure, Nest-free coverage of the statically-derived capability
 * manifest:
 * - **C20 exact shape**: the manifest is exactly
 *   `{ engines: [{ engineId, displayName, local, pinnedEngineVersion,
 *   capabilities: [{ feature, verdict, detail? }] }], defaultEngineId }` with no
 *   `name`/`version`/`since` keys and no unexpected keys;
 * - verdict normalization of both wrapper spellings onto the three-value C20
 *   vocabulary, with `PARTIAL` fail-closed to `NOT_SUPPORTED`;
 * - allowlisting: an unknown registered flavour is skipped and `defaultEngineId`
 *   falls back to the current backend flavour;
 * - no remote probing: building the manifest never invokes a backend method
 *   (`listWorkflows`/`getWorkflow`/`execute`/`initialize`), proven with a spy
 *   backend whose methods throw if called;
 * - **C20 exposure audit**: a recursive scan of the served JSON finds no
 *   forbidden substring (`dsn`, `http://`, `https://`, `password`, `secret`,
 *   `token`, `apiKey`, `Authorization`, `limit`, `blocked`, `namespace`,
 *   `role`) and every `detail` is one of the reviewed static literals.
 */
import { jest, describe, beforeEach, afterAll, it, expect } from "@jest/globals";

import type {
  GraphBackendCapabilities,
  GraphExecutionBackend,
} from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GRAPH_LOCAL_EXECUTION_BACKEND } from "../../../src/engine/constants";
import { DAGSTER_CAPABILITY_TABLE } from "../../../src/dagster/capabilities";
import {
  DAGSTER_BACKEND_FLAVOUR,
  DAGSTER_PINNED_VERSION,
} from "../../../src/dagster/constants";
import { MASTRA_FEATURE_CAPABILITIES } from "../../../src/mastra/MastraCapabilities";
import { MASTRA_BACKEND_FLAVOUR } from "../../../src/mastra/types";
import {
  buildGraphEngineCapabilityManifest,
  localEngineFeatures,
  MASTRA_PINNED_VERSION,
  toGraphEngineFeatureVerdict,
  type GraphEngineCapabilityManifest,
} from "../../../src/nest/graph/GraphEngineCapabilityManifest";

/** A backend whose every method throws if the manifest builder calls it. */
function spyBackend(
  overrides: Partial<GraphExecutionBackend> = {}
): GraphExecutionBackend {
  const boom = (name: string) =>
    jest.fn(() => {
      throw new Error(
        `backend.${name}() must not be invoked while building the manifest`
      );
    });
  return {
    initialize: boom("initialize") as unknown as GraphExecutionBackend["initialize"],
    local: true,
    codeMode: "hostSide",
    capabilities: {
      codeMode: "hostSide",
      workflows: { list: "supported", get: "supported" },
    },
    listWorkflows: boom("listWorkflows") as unknown as GraphExecutionBackend["listWorkflows"],
    getWorkflow: boom("getWorkflow") as unknown as GraphExecutionBackend["getWorkflow"],
    execute: boom("execute") as unknown as GraphExecutionBackend["execute"],
    ...overrides,
  };
}

/** Backend with no declared capabilities: derived from codeMode + method presence. */
function localCapabilityBackend(
  capabilities: GraphBackendCapabilities
): GraphExecutionBackend {
  return {
    initialize: jest.fn(async () => undefined),
    local: true,
    codeMode: capabilities.codeMode,
    capabilities,
    listWorkflows: jest.fn(async () => []),
    getWorkflow: jest.fn(async () => {
      throw new Error("not used");
    }),
    execute: jest.fn(async () => {
      throw new Error("not used");
    }),
  } as unknown as GraphExecutionBackend;
}

/** The forbidden C20 exposure substrings, scanned case-insensitively. */
const FORBIDDEN_SUBSTRINGS = [
  "dsn",
  "http://",
  "https://",
  "password",
  "secret",
  "token",
  "apikey",
  "authorization",
  "limit",
  "blocked",
  "namespace",
  "role",
];

/** Every `detail` value the reviewed static tables may serve. */
const REVIEWED_DETAILS = new Set<string>([
  "Host-side sandbox execution.",
  ...DAGSTER_CAPABILITY_TABLE.map((row) => row.detail).filter(
    (detail): detail is string => detail !== undefined
  ),
  ...MASTRA_FEATURE_CAPABILITIES.map((row) => row.detail).filter(
    (detail): detail is string => detail !== undefined
  ),
]);

/** Recursively collects every string leaf of a JSON-ish value. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
  return out;
}

describe("GraphEngineCapabilityManifest (SAA-197 C20)", () => {
  beforeEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  afterAll(() => {
    GraphExecutionBackendRegistry.clear();
  });

  describe("C20 exact shape", () => {
    it("serves exactly the allowlisted shape with no name/version/since or unexpected keys", () => {
      GraphExecutionBackendRegistry.register(
        GRAPH_LOCAL_EXECUTION_BACKEND,
        spyBackend()
      );
      GraphExecutionBackendRegistry.register(
        DAGSTER_BACKEND_FLAVOUR,
        spyBackend({ local: false })
      );
      GraphExecutionBackendRegistry.register(
        MASTRA_BACKEND_FLAVOUR,
        spyBackend({ local: false })
      );

      const manifest = buildGraphEngineCapabilityManifest(
        GraphExecutionBackendRegistry.list()
      );

      expect(Object.keys(manifest).sort()).toEqual([
        "defaultEngineId",
        "engines",
      ]);
      expect(manifest.engines.map((engine) => engine.engineId)).toEqual([
        GRAPH_LOCAL_EXECUTION_BACKEND,
        DAGSTER_BACKEND_FLAVOUR,
        MASTRA_BACKEND_FLAVOUR,
      ]);

      for (const engine of manifest.engines) {
        expect(Object.keys(engine).sort()).toEqual([
          "capabilities",
          "displayName",
          "engineId",
          "local",
          "pinnedEngineVersion",
        ]);
        for (const capability of engine.capabilities) {
          const keys = Object.keys(capability).sort();
          expect(keys).toContain("feature");
          expect(keys).toContain("verdict");
          for (const key of keys) {
            expect(["detail", "feature", "verdict"]).toContain(key);
          }
        }
      }

      const serialized = JSON.stringify(manifest);
      expect(serialized).not.toMatch(/"name"\s*:/);
      expect(serialized).not.toMatch(/"version"\s*:/);
      expect(serialized).not.toMatch(/"since"\s*:/);
    });

    it("derives the local descriptor from the backend capability metadata", () => {
      const backend = localCapabilityBackend({
        codeMode: "hostSide",
        workflows: { list: "supported", get: "not_supported" },
      });
      GraphExecutionBackendRegistry.register(
        GRAPH_LOCAL_EXECUTION_BACKEND,
        backend
      );

      const manifest = buildGraphEngineCapabilityManifest(
        GraphExecutionBackendRegistry.list()
      );

      expect(manifest.engines).toHaveLength(1);
      expect(manifest.engines[0]).toEqual({
        engineId: GRAPH_LOCAL_EXECUTION_BACKEND,
        displayName: "Local (built-in)",
        local: true,
        pinnedEngineVersion: "built-in",
        capabilities: [
          {
            feature: "codeMode",
            verdict: "SUPPORTED",
            detail: "Host-side sandbox execution.",
          },
          { feature: "workflowList", verdict: "SUPPORTED" },
          { feature: "workflowLookup", verdict: "NOT_SUPPORTED" },
        ],
      });
    });
  });

  describe("verdict normalization", () => {
    it("normalizes the Dagster lowercase spellings", () => {
      expect(toGraphEngineFeatureVerdict("supported")).toBe("SUPPORTED");
      expect(toGraphEngineFeatureVerdict("not_supported")).toBe(
        "NOT_SUPPORTED"
      );
      expect(toGraphEngineFeatureVerdict("extension_point")).toBe(
        "EXTENSION_POINT"
      );
    });

    it("normalizes the Mastra hyphenated spellings", () => {
      expect(toGraphEngineFeatureVerdict("SUPPORTED")).toBe("SUPPORTED");
      expect(toGraphEngineFeatureVerdict("NOT-SUPPORTED")).toBe(
        "NOT_SUPPORTED"
      );
      expect(toGraphEngineFeatureVerdict("EXTENSION-POINT")).toBe(
        "EXTENSION_POINT"
      );
    });

    it("fails PARTIAL closed to NOT_SUPPORTED", () => {
      expect(toGraphEngineFeatureVerdict("PARTIAL")).toBe("NOT_SUPPORTED");
    });

    it("normalizes the served Dagster rows onto the C20 vocabulary", () => {
      GraphExecutionBackendRegistry.register(
        DAGSTER_BACKEND_FLAVOUR,
        spyBackend({ local: false })
      );
      const manifest = buildGraphEngineCapabilityManifest(
        GraphExecutionBackendRegistry.list()
      );
      const dagster = manifest.engines.find(
        (engine) => engine.engineId === DAGSTER_BACKEND_FLAVOUR
      );
      const verdictOf = (feature: string) =>
        dagster?.capabilities.find((row) => row.feature === feature)?.verdict;

      expect(verdictOf("sequential / generic node")).toBe("SUPPORTED");
      expect(verdictOf("while / until loop")).toBe("NOT_SUPPORTED");
      expect(verdictOf("manual trigger")).toBe("EXTENSION_POINT");
      for (const row of DAGSTER_CAPABILITY_TABLE) {
        expect(verdictOf(row.feature)).toBe(
          toGraphEngineFeatureVerdict(row.verdict)
        );
      }
    });

    it("normalizes the served Mastra rows and fails PARTIAL closed", () => {
      GraphExecutionBackendRegistry.register(
        MASTRA_BACKEND_FLAVOUR,
        spyBackend({ local: false })
      );
      const manifest = buildGraphEngineCapabilityManifest(
        GraphExecutionBackendRegistry.list()
      );
      const mastra = manifest.engines.find(
        (engine) => engine.engineId === MASTRA_BACKEND_FLAVOUR
      );
      const verdictOf = (feature: string) =>
        mastra?.capabilities.find((row) => row.feature === feature)?.verdict;

      expect(verdictOf("declarativeDocument")).toBe("SUPPORTED");
      expect(verdictOf("builders")).toBe("EXTENSION_POINT");
      expect(verdictOf("parallel")).toBe("NOT_SUPPORTED");
      expect(verdictOf("errorBoundary")).toBe("NOT_SUPPORTED");
      for (const row of MASTRA_FEATURE_CAPABILITIES) {
        expect(verdictOf(row.feature)).toBe(
          toGraphEngineFeatureVerdict(row.verdict)
        );
      }
      expect(mastra?.pinnedEngineVersion).toBe(MASTRA_PINNED_VERSION);
    });
  });

  describe("allowlist and default engine", () => {
    it("skips a registered flavour that is not allowlisted", () => {
      GraphExecutionBackendRegistry.register(
        GRAPH_LOCAL_EXECUTION_BACKEND,
        spyBackend()
      );
      GraphExecutionBackendRegistry.register(
        "unlisted-engine",
        spyBackend({ local: false })
      );

      const manifest = buildGraphEngineCapabilityManifest(
        GraphExecutionBackendRegistry.list()
      );

      expect(manifest.engines.map((engine) => engine.engineId)).toEqual([
        GRAPH_LOCAL_EXECUTION_BACKEND,
      ]);
      expect(
        manifest.engines.some((engine) => engine.engineId === "unlisted-engine")
      ).toBe(false);
    });

    it("honours a defaultEngineId only when it is an available engine", () => {
      GraphExecutionBackendRegistry.register(
        DAGSTER_BACKEND_FLAVOUR,
        spyBackend({ local: false })
      );

      const withValidDefault = buildGraphEngineCapabilityManifest(
        GraphExecutionBackendRegistry.list(),
        DAGSTER_BACKEND_FLAVOUR
      );
      expect(withValidDefault.defaultEngineId).toBe(DAGSTER_BACKEND_FLAVOUR);

      const withUnknownDefault = buildGraphEngineCapabilityManifest(
        GraphExecutionBackendRegistry.list(),
        "not-an-engine"
      );
      // currentFlavour defaults to "local"; when absent from the ids the first
      // advertised engine wins.
      expect(withUnknownDefault.defaultEngineId).toBe(DAGSTER_BACKEND_FLAVOUR);
    });

    it("falls back to the current flavour when no engine is advertised", () => {
      GraphExecutionBackendRegistry.clear();
      const manifest = buildGraphEngineCapabilityManifest([]);
      expect(manifest.engines).toEqual([]);
      expect(manifest.defaultEngineId).toBe(
        GraphExecutionBackendRegistry.currentFlavour
      );
    });
  });

  describe("no remote probing", () => {
    it("never calls a backend method while building the manifest", () => {
      const backend = spyBackend();
      GraphExecutionBackendRegistry.register(
        GRAPH_LOCAL_EXECUTION_BACKEND,
        backend
      );

      expect(() =>
        buildGraphEngineCapabilityManifest(
          GraphExecutionBackendRegistry.list()
        )
      ).not.toThrow();

      expect(backend.initialize).not.toHaveBeenCalled();
      expect(backend.listWorkflows).not.toHaveBeenCalled();
      expect(backend.getWorkflow).not.toHaveBeenCalled();
      expect(backend.execute).not.toHaveBeenCalled();
    });
  });

  describe("C20 exposure audit", () => {
    it("serves no forbidden substring and only reviewed static details", () => {
      GraphExecutionBackendRegistry.register(
        GRAPH_LOCAL_EXECUTION_BACKEND,
        spyBackend()
      );
      GraphExecutionBackendRegistry.register(
        DAGSTER_BACKEND_FLAVOUR,
        spyBackend({ local: false })
      );
      GraphExecutionBackendRegistry.register(
        MASTRA_BACKEND_FLAVOUR,
        spyBackend({ local: false })
      );

      const manifest = buildGraphEngineCapabilityManifest(
        GraphExecutionBackendRegistry.list()
      );

      const haystack = collectStrings(manifest)
        .join("\n")
        .toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(haystack).not.toContain(forbidden);
      }

      for (const engine of manifest.engines) {
        for (const capability of engine.capabilities) {
          if (capability.detail !== undefined) {
            expect(REVIEWED_DETAILS.has(capability.detail)).toBe(true);
          }
        }
      }
    });

    it("reports the pinned versions from the reviewed constants", () => {
      GraphExecutionBackendRegistry.register(
        DAGSTER_BACKEND_FLAVOUR,
        spyBackend({ local: false })
      );
      GraphExecutionBackendRegistry.register(
        MASTRA_BACKEND_FLAVOUR,
        spyBackend({ local: false })
      );

      const manifest: GraphEngineCapabilityManifest =
        buildGraphEngineCapabilityManifest(
          GraphExecutionBackendRegistry.list()
        );
      const versions = new Map(
        manifest.engines.map((engine) => [
          engine.engineId,
          engine.pinnedEngineVersion,
        ])
      );
      expect(versions.get(DAGSTER_BACKEND_FLAVOUR)).toBe(
        DAGSTER_PINNED_VERSION
      );
      expect(versions.get(MASTRA_BACKEND_FLAVOUR)).toBe(MASTRA_PINNED_VERSION);
    });
  });

  describe("localEngineFeatures", () => {
    it("maps host-side code mode to SUPPORTED and unsupported to NOT_SUPPORTED", () => {
      expect(
        localEngineFeatures({
          codeMode: "hostSide",
          workflows: { list: "supported", get: "supported" },
        })
      ).toEqual([
        {
          feature: "codeMode",
          verdict: "SUPPORTED",
          detail: "Host-side sandbox execution.",
        },
        { feature: "workflowList", verdict: "SUPPORTED" },
        { feature: "workflowLookup", verdict: "SUPPORTED" },
      ]);

      expect(
        localEngineFeatures({
          codeMode: "unsupported",
          workflows: { list: "not_supported", get: "not_supported" },
        })
      ).toEqual([
        {
          feature: "codeMode",
          verdict: "NOT_SUPPORTED",
          detail: "Host-side sandbox execution.",
        },
        { feature: "workflowList", verdict: "NOT_SUPPORTED" },
        { feature: "workflowLookup", verdict: "NOT_SUPPORTED" },
      ]);
    });
  });
});
