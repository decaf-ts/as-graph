/**
 * @module as-graph/tests/integration/nest/GraphBackendHostDagsterBoot.test
 * @summary SAA-709 acceptance 3: boot `GraphExecutionModule.forRoot(host.moduleOptions)`
 * for the `dagster` variant and assert the per-engine workflow catalogue through
 * the real HTTP surface.
 * @description Boots the host-assembled module for the read-only Dagster backend:
 * - without a wired `DagsterClient` the host still boots and advertises the
 *   `dagster` engine, but `GET /graph/engines/dagster/workflows` reports the
 *   engine's honest `NOT_SUPPORTED` verdict as `501`;
 * - with the real `DagsterGraphQLClient` wired, the same route lists the live
 *   deployment's `etl_pipeline` and `asset_pipeline` jobs.
 *
 * The wired-client leg needs a prepared Dagster gateway and skips (never mocks)
 * when none is configured; the no-client leg needs no gateway.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { resetGraphInjectables, resetGraphValueAdapter } from "../../unit/graph/engine-fixtures";
import { TestRequestContextModule } from "../../unit/nest/graphRunTestSupport";
import {
  DAGSTER_EXAMPLE_JOBS,
  dagsterClient,
  dagsterIntegrationDescribe,
} from "../dagster/helpers";

jest.setTimeout(60000);

/** Boots the dagster host-assembled module, optionally with a wired client. */
async function bootDagsterApp(
  initAdapter: boolean,
  client?: ReturnType<typeof dagsterClient>
): Promise<INestApplication> {
  resetGraphInjectables();
  resetGraphValueAdapter();
  const host = await createGraphBackendHost({
    variant: "dagster",
    base: {
      initAdapter,
      runs: { auth: "optional", allowAnonymousAccess: true },
      workflows: { auth: "optional", allowAnonymousAccess: true },
      engines: { auth: "optional" },
    },
    ...(client ? { dagster: { client } } : {}),
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      TestRequestContextModule,
      GraphExecutionModule.forRoot(host.moduleOptions),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe("GraphBackendHost dagster boot (SAA-709 acceptance 3)", () => {
  describe("dagster variant without a wired client", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootDagsterApp(true);
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    it("1. advertises the dagster engine but reports the catalogue as 501", async () => {
      const manifest = await request(app.getHttpServer()).get("/graph/engines");
      expect(manifest.status).toBe(200);
      expect(manifest.body.defaultEngineId).toBe("dagster");
      const dagster = (
        manifest.body.engines as Array<Record<string, unknown>>
      ).find((engine) => engine.engineId === "dagster");
      expect(dagster).toBeDefined();

      const descriptor = await request(app.getHttpServer()).get(
        "/graph/engines/dagster"
      );
      expect(descriptor.status).toBe(200);
      expect(descriptor.body).toEqual(dagster);

      const unknown = await request(app.getHttpServer()).get(
        "/graph/engines/does-not-exist"
      );
      expect(unknown.status).toBe(404);

      const res = await request(app.getHttpServer()).get(
        "/graph/engines/dagster/workflows"
      );
      expect(res.status).toBe(501);
      expect(res.body.message).toContain(
        "Graph workflow catalogue is not supported by the selected engine"
      );
    });
  });

  dagsterIntegrationDescribe(
    "dagster variant with a wired client (SAA-709 acceptance 3)",
    () => {
      let app: INestApplication;

      beforeAll(async () => {
        app = await bootDagsterApp(false, dagsterClient());
      });

      afterAll(async () => {
        try {
          await app.close();
        } catch {
          // already closed
        }
      });

      it("1. lists the live deployment's example jobs on the dagster catalogue", async () => {
        const res = await request(app.getHttpServer()).get(
          "/graph/engines/dagster/workflows"
        );
        expect(res.status).toBe(200);
        expect(
          (res.body as Array<{ workflowId: string }>).map(
            (row) => row.workflowId
          )
        ).toEqual(
          expect.arrayContaining([
            DAGSTER_EXAMPLE_JOBS.etl,
            DAGSTER_EXAMPLE_JOBS.asset,
          ])
        );
      });
    }
  );
});
