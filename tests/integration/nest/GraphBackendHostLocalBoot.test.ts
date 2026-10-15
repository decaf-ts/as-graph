/**
 * @module as-graph/tests/integration/nest/GraphBackendHostLocalBoot.test
 * @summary SAA-709 acceptance 3: boot `GraphExecutionModule.forRoot(host.moduleOptions)`
 * for the `local` variant and assert the capability manifest and the
 * per-engine workflow catalogue through the real HTTP surface.
 * @description Boots the host-assembled module over the header-driven request
 * context harness and exercises the read-only `graph/engines` routes:
 * - `GET /graph/engines` serves the manifest with `defaultEngineId: "local"` and
 *   the local engine present;
 * - `GET /graph/engines/local` serves the same descriptor; an unknown id 404s;
 * - `GET /graph/engines/local/workflows` lists a workflow persisted through
 *   `PUT /graph/workflows/:id` and applies the C23 ownership filter: a *named*
 *   foreign caller does not see another user's workflow. Because the harness runs
 *   with `workflows.allowAnonymousAccess: true`, the explicit DECAF-48 §4.15
 *   standalone tolerance admits an anonymous caller, so filtering is proven with
 *   distinct named callers;
 * - the engine capability `auth` mode is honoured: `"optional"` admits an
 *   anonymous caller (200) and `"required"` rejects a caller with no request
 *   context (401).
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import {
  linearDocument,
  resetGraphInjectables,
  resetGraphValueAdapter,
} from "../../unit/graph/engine-fixtures";
import {
  TEST_USER_HEADER,
  TestRequestContextModule,
} from "../../unit/nest/graphRunTestSupport";

jest.setTimeout(60000);

/** Canonical document for a uniquely-named workflow id. */
function documentWithId(id: string): GraphWorkflowDocument {
  return { ...linearDocument(), id, name: id };
}

/**
 * Boots the local host-assembled module. `withRequestContext` installs the
 * header-driven request context; `initAdapter` installs the standalone RamAdapter
 * on the first boot of this file.
 */
async function bootLocalApp(
  enginesAuth: "optional" | "required",
  options: { withRequestContext?: boolean; initAdapter?: boolean } = {}
): Promise<INestApplication> {
  resetGraphInjectables();
  resetGraphValueAdapter();
  const host = await createGraphBackendHost({
    variant: "local",
    base: {
      initAdapter: options.initAdapter === true,
      runs: { auth: "optional", allowAnonymousAccess: true },
      workflows: { auth: "optional", allowAnonymousAccess: true },
      engines: { auth: enginesAuth },
    },
  });
  const imports: Parameters<typeof Test.createTestingModule>[0]["imports"] = [
    GraphExecutionModule.forRoot(host.moduleOptions),
  ];
  if (options.withRequestContext !== false) {
    imports.unshift(TestRequestContextModule);
  }
  const moduleRef = await Test.createTestingModule({ imports }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe("GraphBackendHost local boot (SAA-709 acceptance 3)", () => {
  describe("local variant, engines auth optional", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootLocalApp("optional", {
        initAdapter: true,
        withRequestContext: true,
      });
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    const api = () => request(app.getHttpServer());

    it("1. GET /graph/engines serves the manifest with the local engine and defaultEngineId local", async () => {
      const res = await api().get("/graph/engines");
      expect(res.status).toBe(200);
      expect(res.body.defaultEngineId).toBe("local");
      const local = (
        res.body.engines as Array<Record<string, unknown>>
      ).find((engine) => engine.engineId === "local");
      expect(local).toBeDefined();
      expect(local).toMatchObject({
        engineId: "local",
        displayName: "Local (built-in)",
        local: true,
        pinnedEngineVersion: "built-in",
      });
    });

    it("2. GET /graph/engines/local serves the same local descriptor", async () => {
      const manifest = await api().get("/graph/engines");
      const expected = (
        manifest.body.engines as Array<Record<string, unknown>>
      ).find((engine) => engine.engineId === "local");

      const res = await api().get("/graph/engines/local");
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expected);
    });

    it("3. GET /graph/engines/:unknown is 404", async () => {
      const res = await api().get("/graph/engines/does-not-exist");
      expect(res.status).toBe(404);
      expect(res.body.message).toContain("does-not-exist");
    });

    it("4. GET /graph/engines/local/workflows lists a persisted workflow and ownership-filters it", async () => {
      const save = await api()
        .put("/graph/workflows/host-local-wf")
        .set(TEST_USER_HEADER, "alice")
        .send(documentWithId("host-local-wf"));
      expect(save.status).toBe(200);

      const ownerList = await api()
        .get("/graph/engines/local/workflows")
        .set(TEST_USER_HEADER, "alice");
      expect(ownerList.status).toBe(200);
      expect(
        (ownerList.body as Array<{ workflowId: string }>).map(
          (row) => row.workflowId
        )
      ).toContain("host-local-wf");

      // A named foreign caller is filtered out by strict owner equality.
      const foreignList = await api()
        .get("/graph/engines/local/workflows")
        .set(TEST_USER_HEADER, "bob");
      expect(foreignList.status).toBe(200);
      expect(
        (foreignList.body as Array<{ workflowId: string }>).map(
          (row) => row.workflowId
        )
      ).not.toContain("host-local-wf");

      // The explicit DECAF-48 §4.15 tolerance admits an anonymous caller to
      // owned resources, so the anonymous catalogue still surfaces it.
      const anonymousList = await api().get("/graph/engines/local/workflows");
      expect(anonymousList.status).toBe(200);
      expect(
        (anonymousList.body as Array<{ workflowId: string }>).map(
          (row) => row.workflowId
        )
      ).toContain("host-local-wf");
    });

    it("5. GET /graph/engines/local/workflows/:workflowId serves the canonical document", async () => {
      const save = await api()
        .put("/graph/workflows/host-local-doc")
        .set(TEST_USER_HEADER, "alice")
        .send(documentWithId("host-local-doc"));
      expect(save.status).toBe(200);

      const res = await api()
        .get("/graph/engines/local/workflows/host-local-doc")
        .set(TEST_USER_HEADER, "alice");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("host-local-doc");
      expect(res.body.name).toBe("host-local-doc");
    });
  });

  describe("engines auth required with no request context", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootLocalApp("required", {
        initAdapter: false,
        withRequestContext: false,
      });
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    it("1. rejects GET /graph/engines with 401", async () => {
      const res = await request(app.getHttpServer()).get("/graph/engines");
      expect(res.status).toBe(401);
      expect(res.body.message).toContain(
        "requires an authenticated request context"
      );
    });
  });
});
