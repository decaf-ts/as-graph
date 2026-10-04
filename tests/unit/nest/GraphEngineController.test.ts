/**
 * @module as-graph/tests/unit/nest/GraphEngineController.test
 * @summary SAA-197 verification for the engine capability HTTP API
 * (`src/nest/graph/GraphEngineController.ts`) covering C20 (manifest route)
 * and C21 (auth posture, allowlisted ids, no error-detail leakage, rate limit).
 * @description Boots the real {@link GraphExecutionModule} through the shared
 * header-driven harness (`TestRequestContextModule`) and exercises the read-only
 * `graph/engines` routes over HTTP:
 * - `GET /graph/engines` serves the C20 manifest with `defaultEngineId:
 *   "local"` and the local engine present (exact shape);
 * - `GET /graph/engines/local` serves the local descriptor; an unknown id is
 *   `404` and reflects no query parameters beyond the static message;
 * - `GET /graph/engines/local/workflows` serves the persisted workflow
 *   summaries through the engine facade; `.../:workflowId` serves the canonical
 *   document and `404`s an unknown id;
 * - C21 auth posture: `engines: { auth: "required" }` rejects a caller with no
 *   resolved owner with `401`, matching the other graph read routes;
 * - no `GraphExecutionError.details` leakage: a backend failure surfaces as the
 *   constant generic `500` (or `501` for `GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED`)
 *   and never the sentinel detail;
 * - C21 rate limiting: the `engines` throttler bucket is wired in the module
 *   and the engine routes carry the throttler guard metadata.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { getOptionsToken } from "@nestjs/throttler";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphExecutionError } from "../../../src/engine/errors/GraphExecutionError";
import { GraphWorkflowService } from "../../../src/engine/services/GraphWorkflowService";
import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";
import {
  GraphEngineController,
} from "../../../src/nest/graph/GraphEngineController";
import {
  GRAPH_ENGINE_CAPABILITY_OPTIONS,
  GraphEngineCapabilityService,
  type GraphEngineCapabilityOptions,
} from "../../../src/nest/graph/GraphEngineCapabilityService";
import { GRAPH_SERVING_INTERNAL_ERROR_MESSAGE } from "../../../src/nest/graph/servingErrors";
import { linearDocument } from "../graph/engine-fixtures";
import {
  TEST_USER_HEADER,
  TestRequestContextModule,
} from "./graphRunTestSupport";

jest.setTimeout(60000);

/** Throttler metadata keys (mirrors `@nestjs/throttler`'s private constants). */
const THROTTLER_LIMIT = "THROTTLER:LIMIT";
const THROTTLER_SKIP = "THROTTLER:SKIP";

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Whether a standalone `RamAdapter` has already been installed for this file.
 * `RamAdapter` can only be constructed once per process, so only the first boot
 * installs it; later boots reuse the globally-current adapter.
 */
let adapterReady = false;

/** Boots the real module with the supplied engine capability options. */
async function bootEnginesApp(
  engines: GraphEngineCapabilityOptions,
  withRequestContext = true
): Promise<{ app: INestApplication; moduleRef: TestingModule }> {
  const imports: Parameters<typeof Test.createTestingModule>[0]["imports"] = [
    GraphExecutionModule.forRoot({
      initAdapter: !adapterReady,
      runs: { auth: "optional", allowAnonymousAccess: true },
      workflows: { auth: "optional", allowAnonymousAccess: true },
      engines,
    }),
  ];
  if (withRequestContext) imports.unshift(TestRequestContextModule);
  const moduleRef = await Test.createTestingModule({ imports }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  adapterReady = true;
  return { app, moduleRef };
}

/** Canonical document for a uniquely-named workflow id. */
function documentWithId(id: string): GraphWorkflowDocument {
  return { ...linearDocument(), id, name: id };
}

describe("GraphEngineController (SAA-197)", () => {
  describe("capability manifest and engine catalogue (auth optional)", () => {
    let app: INestApplication;
    let moduleRef: TestingModule;

    beforeAll(async () => {
      ({ app, moduleRef } = await bootEnginesApp({ auth: "optional" }));
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    const api = () => request(app.getHttpServer());

    it("1. GET /graph/engines serves the C20 manifest with the local engine and defaultEngineId local", async () => {
      const res = await api().get("/graph/engines");
      expect(res.status).toBe(200);

      expect(Object.keys(res.body).sort()).toEqual([
        "defaultEngineId",
        "engines",
      ]);
      expect(res.body.defaultEngineId).toBe("local");
      expect(Array.isArray(res.body.engines)).toBe(true);

      const local = (res.body.engines as Array<Record<string, unknown>>).find(
        (engine) => engine.engineId === "local"
      );
      expect(local).toBeDefined();
      expect(local).toMatchObject({
        engineId: "local",
        displayName: "Local (built-in)",
        local: true,
        pinnedEngineVersion: "built-in",
      });

      for (const engine of res.body.engines as Array<
        Record<string, unknown>
      >) {
        expect(Object.keys(engine).sort()).toEqual([
          "capabilities",
          "displayName",
          "engineId",
          "local",
          "pinnedEngineVersion",
        ]);
        const capabilities = engine.capabilities as Array<
          Record<string, unknown>
        >;
        expect(Array.isArray(capabilities)).toBe(true);
        for (const capability of capabilities) {
          expect(typeof capability.feature).toBe("string");
          expect(["SUPPORTED", "NOT_SUPPORTED", "EXTENSION_POINT"]).toContain(
            capability.verdict
          );
        }
      }

      const localCapabilities = (local as { capabilities: Array<{ feature: string; verdict: string }> })
        .capabilities;
      expect(localCapabilities).toContainEqual({
        feature: "codeMode",
        verdict: "SUPPORTED",
        detail: "Host-side sandbox execution.",
      });
      expect(localCapabilities).toContainEqual({
        feature: "workflowList",
        verdict: "SUPPORTED",
      });
      expect(localCapabilities).toContainEqual({
        feature: "workflowLookup",
        verdict: "SUPPORTED",
      });
    });

    it("2. GET /graph/engines/local serves the local descriptor", async () => {
      const res = await api().get("/graph/engines/local");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        engineId: "local",
        displayName: "Local (built-in)",
        local: true,
        pinnedEngineVersion: "built-in",
      });
    });

    it("3. GET /graph/engines/:unknown is 404 and reflects no query parameters", async () => {
      const res = await api().get(
        "/graph/engines/does-not-exist?foo=SENTINEL_QUERY&password=SENTINEL_PW"
      );
      expect(res.status).toBe(404);
      expect(res.body.message).toBe(
        "No graph engine 'does-not-exist' is available"
      );
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain("SENTINEL_QUERY");
      expect(serialized).not.toContain("SENTINEL_PW");
    });

    it("4. GET /graph/engines/local/workflows serves persisted summaries with ISO dates", async () => {
      const saveA = await api()
        .put("/graph/workflows/engine-wf-a")
        .send(documentWithId("engine-wf-a"));
      expect(saveA.status).toBe(200);
      const saveB = await api()
        .put("/graph/workflows/engine-wf-b")
        .send(documentWithId("engine-wf-b"));
      expect(saveB.status).toBe(200);

      const res = await api().get("/graph/engines/local/workflows");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const ids = (res.body as Array<{ workflowId: string }>).map(
        (row) => row.workflowId
      );
      expect(ids).toEqual(
        expect.arrayContaining(["engine-wf-a", "engine-wf-b"])
      );

      for (const row of res.body as Array<Record<string, unknown>>) {
        expect(typeof row.workflowId).toBe("string");
        if (row.name !== undefined) expect(typeof row.name).toBe("string");
        if (row.updatedAt !== undefined) {
          expect(typeof row.updatedAt).toBe("string");
          expect(row.updatedAt).toMatch(ISO_8601);
        }
        for (const key of Object.keys(row)) {
          expect(["workflowId", "name", "updatedAt"]).toContain(key);
        }
      }
    });

    it("5. GET /graph/engines/local/workflows/:workflowId serves the canonical document", async () => {
      const save = await api()
        .put("/graph/workflows/engine-doc-wf")
        .send(documentWithId("engine-doc-wf"));
      expect(save.status).toBe(200);

      const res = await api().get(
        "/graph/engines/local/workflows/engine-doc-wf"
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("engine-doc-wf");
      expect(res.body.name).toBe("engine-doc-wf");
      expect(res.body.nodes).toEqual(
        documentWithId("engine-doc-wf").nodes
      );
    });

    it("6. GET /graph/engines/local/workflows/:unknownWorkflowId is 404", async () => {
      const res = await api().get(
        "/graph/engines/local/workflows/no-such-workflow"
      );
      // SAA-206 finding (implementation gap): `GraphWorkflowService.getDocument`
      // throws a Decaf `NotFoundError` for an unknown workflow id, but
      // `GraphEngineController.graphEngineHttpErrorOf` has no `NotFoundError`
      // branch (unlike `GraphWorkflowController.graphWorkflowHttpErrorOf`), so
      // the request is served as the generic 500
      // `{"statusCode":500,"message":"Internal server error"}` instead of 404.
      expect(res.status).toBe(404);
      expect(res.body.message).toContain("no-such-workflow");
    });

    it("7. the engines throttler bucket is wired and the routes carry throttler metadata", () => {
      const options = moduleRef.get(getOptionsToken(), { strict: false }) as
        | Array<{ name?: string }>
        | undefined;
      expect(Array.isArray(options)).toBe(true);
      expect(
        (options ?? []).some((bucket) => bucket.name === "engines")
      ).toBe(true);

      for (const handler of ["getManifest", "getEngine", "listWorkflows", "getWorkflow"] as const) {
        const fn = GraphEngineController.prototype[handler];
        expect(
          Reflect.hasMetadata(`${THROTTLER_LIMIT}engines`, fn)
        ).toBe(true);
        expect(
          Reflect.getMetadata(`${THROTTLER_SKIP}default`, fn)
        ).toBe(true);
      }
    });

    it("8. resolves the capability service and workflow service through the real module wiring", () => {
      // The controller is request-scoped (it injects the request-scoped
      // `DecafRequestContext`), so its reachability is proven by the 200/404/500
      // route assertions above; its collaborators resolve as singletons.
      expect(moduleRef.get(GraphEngineCapabilityService)).toBeInstanceOf(
        GraphEngineCapabilityService
      );
      expect(moduleRef.get(GraphWorkflowService)).toBeInstanceOf(
        GraphWorkflowService
      );
    });
  });

  describe("C21 auth posture (auth required)", () => {
    /**
     * Boots only the controller with the real capability service: the auth gate
     * runs before the manifest is ever built, so no engine boot (and no global
     * catalogue singleton) is needed to exercise the 401/200 posture.
     */
    async function bootAuthApp(
      withRequestContext: boolean
    ): Promise<INestApplication> {
      const moduleRef = await Test.createTestingModule({
        imports: withRequestContext ? [TestRequestContextModule] : [],
        controllers: [GraphEngineController],
        providers: [
          {
            provide: GraphEngineCapabilityService,
            useValue: new GraphEngineCapabilityService(),
          },
          {
            provide: GRAPH_ENGINE_CAPABILITY_OPTIONS,
            useValue: { auth: "required" },
          },
        ],
      }).compile();
      const authApp = moduleRef.createNestApplication();
      await authApp.init();
      return authApp;
    }

    it("1. rejects GET /graph/engines with 401 when the context has no resolved owner", async () => {
      const app = await bootAuthApp(true);
      try {
        const res = await request(app.getHttpServer()).get("/graph/engines");
        expect(res.status).toBe(401);
        expect(res.body.message).toContain("requires an authenticated user");
      } finally {
        await app.close();
      }
    });

    it("2. rejects GET /graph/engines with 401 when no request context is available", async () => {
      const app = await bootAuthApp(false);
      try {
        const res = await request(app.getHttpServer()).get("/graph/engines");
        expect(res.status).toBe(401);
        expect(res.body.message).toContain(
          "requires an authenticated request context"
        );
      } finally {
        await app.close();
      }
    });

    it("3. admits an authenticated caller on GET /graph/engines", async () => {
      const app = await bootAuthApp(true);
      try {
        const res = await request(app.getHttpServer())
          .get("/graph/engines")
          .set(TEST_USER_HEADER, "alice");
        expect(res.status).toBe(200);
        expect(res.body.defaultEngineId).toBe("local");
      } finally {
        await app.close();
      }
    });
  });

  describe("error-detail non-leakage (C21)", () => {
    const SENTINEL = "SENTINEL_DETAILS_should_never_leak";
    let app: INestApplication;

    /** Stub capability service: allowlists local, throws a sentinel-laden error. */
    function capabilityStub(
      error: GraphExecutionError
    ): Partial<GraphEngineCapabilityService> {
      return {
        isKnownEngine: jest.fn(() => true),
        manifestSnapshot: jest.fn(() => ({
          engines: [],
          defaultEngineId: "local",
        })),
        descriptor: jest.fn(() => undefined),
        listWorkflows: jest.fn(async () => {
          throw error;
        }),
        getWorkflow: jest.fn(async () => {
          throw error;
        }),
      };
    }

    async function bootStubApp(
      error: GraphExecutionError
    ): Promise<INestApplication> {
      const moduleRef = await Test.createTestingModule({
        controllers: [GraphEngineController],
        providers: [
          {
            provide: GraphEngineCapabilityService,
            useValue: capabilityStub(error),
          },
          {
            provide: GRAPH_ENGINE_CAPABILITY_OPTIONS,
            useValue: { auth: "optional" },
          },
        ],
      }).compile();
      const stubApp = moduleRef.createNestApplication();
      await stubApp.init();
      return stubApp;
    }

    beforeAll(async () => {
      app = await bootStubApp(
        new GraphExecutionError(
          "engine listing failed",
          "GRAPH_ENGINE_LIST_FAILED",
          { sentinel: SENTINEL }
        )
      );
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    const api = () => request(app.getHttpServer());

    it("1. a backend failure is the constant generic 500 without the sentinel details", async () => {
      const res = await api().get("/graph/engines/local/workflows");
      expect(res.status).toBe(500);
      expect(res.body.message).toBe(GRAPH_SERVING_INTERNAL_ERROR_MESSAGE);
      const serialized = `${JSON.stringify(res.body)}\n${res.text}`;
      expect(serialized).not.toContain(SENTINEL);
    });

    it("2. a workflow lookup failure is the constant generic 500 without the sentinel details", async () => {
      const res = await api().get(
        "/graph/engines/local/workflows/wf-1"
      );
      expect(res.status).toBe(500);
      expect(res.body.message).toBe(GRAPH_SERVING_INTERNAL_ERROR_MESSAGE);
      const serialized = `${JSON.stringify(res.body)}\n${res.text}`;
      expect(serialized).not.toContain(SENTINEL);
    });

    it("3. GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED maps to 501 without the sentinel details", async () => {
      const notSupportedApp = await bootStubApp(
        new GraphExecutionError(
          "no catalogue",
          "GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED",
          { sentinel: SENTINEL }
        )
      );
      try {
        const res = await request(notSupportedApp.getHttpServer()).get(
          "/graph/engines/local/workflows"
        );
        expect(res.status).toBe(501);
        expect(res.body.message).toBe(
          "Graph workflow catalogue is not supported by the selected engine"
        );
        const serialized = `${JSON.stringify(res.body)}\n${res.text}`;
        expect(serialized).not.toContain(SENTINEL);
      } finally {
        await notSupportedApp.close();
      }
    });
  });
});
