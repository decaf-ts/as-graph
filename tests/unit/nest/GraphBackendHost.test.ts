/**
 * @module as-graph/tests/unit/nest/GraphBackendHost.test
 * @summary SAA-709 verification for the boot-time engine-variant selection
 * (`src/nest/graph/GraphBackendHost.ts`), the backend half of SAA-687.
 * @description Nest-free coverage of the host assembly:
 * - `parseGraphEngineVariant` resolves the three variants (case/whitespace
 *   tolerant), defaults `undefined`/empty to the fallback, and fails closed with
 *   `GraphExecutionError` code `GRAPH_BACKEND_ENGINE_UNKNOWN` on a typo;
 * - `graphEngineVariantFromEnv` reads `GRAPH_BACKEND_ENGINE`;
 * - `createGraphBackendHost` constructs and registers the real backend per variant:
 *   `mastra`/`dagster` return a `backend` whose registry flavour is the variant
 *   and select it as the registry current, while `local` leaves `backend` undefined
 *   (the engine builds the built-in local backend);
 * - the assembled `moduleOptions` carries `engines.defaultEngineId === variant`
 *   and preserves the caller's base options (auth/limits/adapter);
 * - `graphEngineIdOf` maps each variant onto its allowlisted engine id.
 */
import { describe, beforeEach, afterEach, it, expect } from "@jest/globals";

import { GraphExecutionError } from "../../../src/engine/errors/GraphExecutionError";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GRAPH_LOCAL_EXECUTION_BACKEND } from "../../../src/engine/constants";
import { MASTRA_BACKEND_FLAVOUR } from "../../../src/mastra/types";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { DAGSTER_BACKEND_FLAVOUR } from "../../../src/dagster/constants";
import { DagsterGraphExecutionBackend } from "../../../src/dagster/DagsterGraphExecutionBackend";
import {
  createGraphBackendHost,
  parseGraphEngineVariant,
  graphEngineVariantFromEnv,
  graphEngineIdOf,
  GRAPH_ENGINE_VARIANTS,
  GRAPH_BACKEND_ENGINE_ENV,
  DEFAULT_GRAPH_ENGINE_VARIANT,
  type GraphEngineVariant,
} from "../../../src/nest/graph/GraphBackendHost";

describe("GraphBackendHost (SAA-709)", () => {
  beforeEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  describe("variant constants", () => {
    it("enumerates exactly the three bootable variants in manifest order", () => {
      expect([...GRAPH_ENGINE_VARIANTS]).toEqual([
        "local",
        "mastra",
        "dagster",
      ]);
    });

    it("names the selection env var and defaults to local", () => {
      expect(GRAPH_BACKEND_ENGINE_ENV).toBe("GRAPH_BACKEND_ENGINE");
      expect(DEFAULT_GRAPH_ENGINE_VARIANT).toBe("local");
    });
  });

  describe("parseGraphEngineVariant", () => {
    it.each([
      ["mastra", "mastra"],
      ["MASTRA ", "mastra"],
      ["dagster", "dagster"],
      ["local", "local"],
      ["  Dagster  ", "dagster"],
    ] as Array<[string, GraphEngineVariant]>)(
      "resolves '%s' to '%s'",
      (value, expected) => {
        expect(parseGraphEngineVariant(value)).toBe(expected);
      }
    );

    it("defaults undefined and blank values to the default variant", () => {
      expect(parseGraphEngineVariant(undefined)).toBe("local");
      expect(parseGraphEngineVariant("")).toBe("local");
      expect(parseGraphEngineVariant("   ")).toBe("local");
    });

    it("honours an explicit fallback for undefined and blank values", () => {
      expect(parseGraphEngineVariant(undefined, "mastra")).toBe("mastra");
      expect(parseGraphEngineVariant("", "dagster")).toBe("dagster");
      expect(parseGraphEngineVariant("  ", "mastra")).toBe("mastra");
    });

    it("throws a GraphExecutionError with GRAPH_BACKEND_ENGINE_UNKNOWN for an unknown value", () => {
      let thrown: unknown;
      try {
        parseGraphEngineVariant("kubernetes");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GraphExecutionError);
      expect((thrown as GraphExecutionError).graphCode).toBe(
        "GRAPH_BACKEND_ENGINE_UNKNOWN"
      );
      expect((thrown as Error).message).toContain("kubernetes");
      expect((thrown as Error).message).toContain("local, mastra, dagster");
    });
  });

  describe("graphEngineVariantFromEnv", () => {
    it("reads the variant from GRAPH_BACKEND_ENGINE", () => {
      expect(
        graphEngineVariantFromEnv({
          [GRAPH_BACKEND_ENGINE_ENV]: "mastra",
        } as NodeJS.ProcessEnv)
      ).toBe("mastra");
      expect(
        graphEngineVariantFromEnv({
          [GRAPH_BACKEND_ENGINE_ENV]: "DAGSTER",
        } as NodeJS.ProcessEnv)
      ).toBe("dagster");
    });

    it("defaults to local when the env var is unset or blank", () => {
      expect(graphEngineVariantFromEnv({} as NodeJS.ProcessEnv)).toBe("local");
      expect(
        graphEngineVariantFromEnv({
          [GRAPH_BACKEND_ENGINE_ENV]: "   ",
        } as NodeJS.ProcessEnv)
      ).toBe("local");
    });

    it("fails closed on an unknown configured value", () => {
      expect(() =>
        graphEngineVariantFromEnv({
          [GRAPH_BACKEND_ENGINE_ENV]: "typo",
        } as NodeJS.ProcessEnv)
      ).toThrow(GraphExecutionError);
    });
  });

  describe("graphEngineIdOf", () => {
    it("maps each variant onto its allowlisted engine id", () => {
      expect(graphEngineIdOf("local")).toBe(GRAPH_LOCAL_EXECUTION_BACKEND);
      expect(graphEngineIdOf("mastra")).toBe(MASTRA_BACKEND_FLAVOUR);
      expect(graphEngineIdOf("dagster")).toBe(DAGSTER_BACKEND_FLAVOUR);
    });

    it("maps every declared variant to a non-empty engine id", () => {
      for (const variant of GRAPH_ENGINE_VARIANTS) {
        expect(typeof graphEngineIdOf(variant)).toBe("string");
        expect(graphEngineIdOf(variant).length).toBeGreaterThan(0);
      }
    });
  });

  describe("createGraphBackendHost", () => {
    it("boots the local variant with no constructed backend and selects it as current", async () => {
      const host = await createGraphBackendHost({ variant: "local" });

      expect(host.variant).toBe("local");
      expect(host.engineId).toBe(GRAPH_LOCAL_EXECUTION_BACKEND);
      expect(host.backend).toBeUndefined();
      expect(host.moduleOptions.engines?.defaultEngineId).toBe("local");
      expect(GraphExecutionBackendRegistry.currentFlavour).toBe("local");
    });

    it("boots the mastra variant with a registered mastra backend selected as current", async () => {
      const host = await createGraphBackendHost({ variant: "mastra" });

      expect(host.variant).toBe("mastra");
      expect(host.engineId).toBe(MASTRA_BACKEND_FLAVOUR);
      expect(host.moduleOptions.engines?.defaultEngineId).toBe("mastra");
      expect(host.backend).toBeInstanceOf(MastraGraphExecutionBackend);
      expect(
        GraphExecutionBackendRegistry.get(MASTRA_BACKEND_FLAVOUR)
      ).toBe(host.backend);
      expect(GraphExecutionBackendRegistry.currentFlavour).toBe(
        MASTRA_BACKEND_FLAVOUR
      );
    });

    it("boots the dagster variant with a registered dagster backend selected as current", async () => {
      const host = await createGraphBackendHost({ variant: "dagster" });

      expect(host.variant).toBe("dagster");
      expect(host.engineId).toBe(DAGSTER_BACKEND_FLAVOUR);
      expect(host.moduleOptions.engines?.defaultEngineId).toBe("dagster");
      expect(host.backend).toBeInstanceOf(DagsterGraphExecutionBackend);
      expect(
        GraphExecutionBackendRegistry.get(DAGSTER_BACKEND_FLAVOUR)
      ).toBe(host.backend);
      expect(GraphExecutionBackendRegistry.currentFlavour).toBe(
        DAGSTER_BACKEND_FLAVOUR
      );
    });

    it("preserves caller base options while overriding the backend and default engine", async () => {
      const host = await createGraphBackendHost({
        variant: "mastra",
        base: {
          initAdapter: true,
          engines: { auth: "required", defaultEngineId: "dagster" },
          runs: { auth: "optional", allowAnonymousAccess: true },
          workflows: { auth: "optional", allowAnonymousAccess: true },
        },
      });

      expect(host.moduleOptions.initAdapter).toBe(true);
      expect(host.moduleOptions.engines?.auth).toBe("required");
      expect(host.moduleOptions.engines?.defaultEngineId).toBe("mastra");
      expect(host.moduleOptions.runs).toMatchObject({
        auth: "optional",
        allowAnonymousAccess: true,
      });
      expect(host.moduleOptions.workflows).toMatchObject({
        auth: "optional",
        allowAnonymousAccess: true,
      });
    });

    it("registers a distinct backend instance per boot and re-points current", async () => {
      const first = await createGraphBackendHost({ variant: "mastra" });
      const second = await createGraphBackendHost({ variant: "dagster" });

      expect(second.backend).not.toBe(first.backend);
      expect(
        GraphExecutionBackendRegistry.get(MASTRA_BACKEND_FLAVOUR)
      ).toBe(first.backend);
      expect(
        GraphExecutionBackendRegistry.get(DAGSTER_BACKEND_FLAVOUR)
      ).toBe(second.backend);
      expect(GraphExecutionBackendRegistry.currentFlavour).toBe(
        DAGSTER_BACKEND_FLAVOUR
      );
    });

    it("returns the dagster backend carrying the wired client", async () => {
      const client = { listJobs: async () => [] } as never;
      const host = await createGraphBackendHost({
        variant: "dagster",
        dagster: { client },
      });

      expect(
        (host.backend as DagsterGraphExecutionBackend).config?.client
      ).toBe(client);
    });

    it("returns the mastra backend carrying the wired step handlers", async () => {
      const stepHandler = {
        kind: "test.leaf",
        createStep: () => ({}) as never,
      };
      const host = await createGraphBackendHost({
        variant: "mastra",
        mastra: { mastra: {}, stepHandlers: [stepHandler] },
      });

      expect(
        (host.backend as MastraGraphExecutionBackend).config?.stepHandlers
      ).toHaveLength(1);
    });
  });
});
