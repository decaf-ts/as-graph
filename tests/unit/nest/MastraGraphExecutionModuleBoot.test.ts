/**
 * @module as-graph/tests/unit/nest/MastraGraphExecutionModuleBoot
 * @summary Driver tests for the mastra NestJS engine-boot integration
 * (SAA-836 O1, SAA-877).
 * @description Proves {@link MastraGraphExecutionModule.forRoot} composes the
 * graph serving stack over the mastra engine: the async `backendFactory`
 * constructs and initializes the real {@link MastraGraphExecutionBackend}
 * against a minimal in-memory (duck-typed) mastra runtime, the capability
 * manifest advertises the `mastra` flavour as the default engine id, and the
 * application-shutdown hook disposes the booted backend (observability flush +
 * owned persistence adapters) while staying a no-op when nothing booted. The
 * disabled lane (`MASTRA__ENGINE__ENABLED=false`) fails closed at boot with
 * `GRAPH_MASTRA_ENGINE_DISABLED`.
 *
 * Test-infra note: `GraphNodeCatalogue` is a decaf `@service()` process
 * singleton, so a jest worker can complete exactly one `GraphExecutionModule`
 * boot per fresh catalogue. The happy-path app is booted once and shared; the
 * disabled-lane test resets the singleton through the catalogue's public
 * `listKinds`/`unregister` surface before its boot so the built-in
 * registrations re-apply.
 */
import { jest, describe, it, expect, beforeAll, afterAll } from "@jest/globals";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";

import {
  MASTRA_GRAPH_BACKEND_SHUTDOWN,
  MastraGraphBackendShutdown,
  MastraGraphExecutionModule,
} from "../../../src/mastra/MastraGraphExecutionModule";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { GRAPH_MASTRA_ENGINE_DISABLED } from "../../../src/mastra/MastraEnvironment";
import { GraphExecutionEngine, GraphNodeModelService } from "../../../src";
import { GraphEngineCapabilityService } from "../../../src/nest/graph";
import { TestRequestContextModule } from "./graphRunTestSupport";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GraphNodeCatalogue } from "../../../src/engine/catalog/GraphNodeCatalogue";

jest.setTimeout(30000);

/**
 * Walks an error and its `cause` chain looking for a graph code (the
 * `GraphExecutionError.graphCode` property). Nest may wrap a failing provider
 * factory's rejection, so the code is resolved through the chain instead of
 * assuming the rejection is the raw error.
 */
function graphCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    const candidate = current as { graphCode?: unknown; cause?: unknown };
    if (typeof candidate.graphCode === "string") return candidate.graphCode;
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Resets the `@service()` singleton catalogue so the next module boot
 * re-applies the built-in node registrations (see the module doc's test-infra
 * note). Uses only the catalogue's public `listKinds`/`unregister` surface.
 */
function resetGraphNodeCatalogue(): void {
  const catalogue = new GraphNodeCatalogue();
  for (const kind of catalogue.listKinds()) {
    catalogue.unregister(kind);
  }
}

describe("MastraGraphExecutionModule boot (SAA-836 O1)", () => {
  let app: INestApplication | undefined;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TestRequestContextModule,
        MastraGraphExecutionModule.forRoot({
          mastra: { mastra: {} },
          base: {
            initAdapter: true,
            runs: { auth: "optional", allowAnonymousAccess: true },
            workflows: { auth: "optional", allowAnonymousAccess: true },
          },
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 20000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      // already closed by the shutdown test
    }
    GraphExecutionBackendRegistry.clear();
  });

  /**
   * Boots the mastra module against the minimal in-memory mastra runtime (a
   * duck-typed `{}` runtime: no `registerExporter`, so observability wiring is
   * skipped exactly as for test doubles) and initializes the app.
   */
  it("boots the mastra backend through backendFactory and serves the mastra engine flavour", async () => {
    const engine = moduleRef.get(GraphExecutionEngine, { strict: false });
    const backend = engine.backend;
    expect(backend).toBeInstanceOf(MastraGraphExecutionBackend);
    expect((backend as MastraGraphExecutionBackend).ready).toBe(true);
    expect(backend.local).toBe(false);
    expect(backend.codeMode).toBe("unsupported");

    const capability = moduleRef.get(GraphEngineCapabilityService, {
      strict: false,
    });
    const manifest = capability.manifestSnapshot();
    expect(manifest.defaultEngineId).toBe("mastra");
    expect(manifest.engines.map((entry) => entry.engineId)).toContain("mastra");
  });

  it("registers the shutdown hook provider under MASTRA_GRAPH_BACKEND_SHUTDOWN", () => {
    const hook = moduleRef.get<MastraGraphBackendShutdown>(
      MASTRA_GRAPH_BACKEND_SHUTDOWN,
      { strict: false }
    );
    expect(hook).toBeInstanceOf(MastraGraphBackendShutdown);
  });

  it("disposes the booted mastra backend on application shutdown", async () => {
    const backend = moduleRef.get(GraphExecutionEngine, {
      strict: false,
    }).backend as MastraGraphExecutionBackend;
    const disposeSpy = jest.spyOn(backend, "dispose");

    await app!.close();
    app = undefined;

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(backend.ready).toBe(false);
  });

  it("shutdown hook stays a no-op when no mastra backend booted", async () => {
    const hook = new MastraGraphBackendShutdown(() => undefined);
    await expect(hook.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it("shutdown hook delegates dispose to the resolved backend", async () => {
    const dispose = jest.fn<() => Promise<void>>(async () => undefined);
    const hook = new MastraGraphBackendShutdown(
      () => ({ dispose }) as unknown as MastraGraphExecutionBackend
    );
    await hook.onApplicationShutdown();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("fails closed with GRAPH_MASTRA_ENGINE_DISABLED when MASTRA__ENGINE__ENABLED=false", async () => {
    resetGraphNodeCatalogue();
    process.env["MASTRA__ENGINE__ENABLED"] = "false";
    let caught: unknown;
    try {
      const disabledModuleRef = await Test.createTestingModule({
        imports: [
          TestRequestContextModule,
          MastraGraphExecutionModule.forRoot({
            mastra: { mastra: {} },
            base: { initAdapter: true },
          }),
        ],
      })
        // The engine factory rejects the disabled lane, but Nest instantiates
        // providers in parallel: without this override the node-model boot
        // sync keeps running (and logging) past the suite's end.
        .overrideProvider(GraphNodeModelService)
        .useValue({ syncFromCatalogue: async () => undefined } as never)
        .compile();
      const disabledApp = disabledModuleRef.createNestApplication();
      await disabledApp.init();
      await disabledApp.close();
    } catch (error) {
      caught = error;
    } finally {
      delete process.env["MASTRA__ENGINE__ENABLED"];
    }
    expect(caught).toBeDefined();
    expect(graphCodeOf(caught)).toBe(GRAPH_MASTRA_ENGINE_DISABLED);
  });
});
