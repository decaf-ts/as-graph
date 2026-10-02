/**
 * @module as-graph/tests/unit/nest/GraphRunRealAuthOwnership
 * @summary DECAF-50 K24 follow-up (SAA-1377): run ownership under the REAL
 * for-nest auth stack, not the header-driven `TestRequestContext` mock.
 * @description The other committed run-ownership suites bind the caller through a
 * request-scoped `TestRequestContext` override (`graphRunTestSupport.ts:62-71`)
 * that reads a test-only header. That proves the graph ownership logic, but it
 * never exercises the real `DecafAuthModule` -> `AuthMiddleware` ->
 * `AuthHandler.bindToContext` binding, so a regression that renamed the bound key
 * (e.g. `user` -> `sub`) would not fail CI.
 *
 * This suite boots {@link GraphExecutionModule} next to the real
 * `DecafAuthModule.forRoot({ global: true, handler: DecafAuthHandler })` stack and
 * pins run ownership end to end:
 * - `DecafAuthHandler.prime` binds the bearer token onto the request context so
 *   `graphWorkflowOwnerOf(ctx)` resolves the caller, and an unbound `Context`
 *   resolves to `undefined`;
 * - `auth: "optional"` + `allowAnonymousAccess: true`: the owner reads her run
 *   (200), a different user is denied (403) on the status/result and the
 *   event stream, and an anonymous caller is tolerated (200);
 * - secure defaults (`auth: "required"`, `allowAnonymousAccess: false`): the
 *   anonymous caller is denied (403, fail-closed).
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import { Context } from "@decaf-ts/core";
import { RamAdapter } from "@decaf-ts/core/ram";
import { RamTransformer } from "@decaf-ts/for-http/server";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { TestingModule } from "@nestjs/testing";
import {
  DecafAuthHandler,
  DecafAuthModule,
  DecafModule,
  DecafRequestContext,
} from "@decaf-ts/for-nest";

import { GraphExecutionModule } from "../../../src/nest/graph";
import type { GraphRunControllerOptions } from "../../../src/nest/graph";
import { GraphRunService } from "../../../src";
import { graphWorkflowOwnerOf } from "../../../src/engine/services/GraphWorkflowService";
import {
  linearDocument,
  resetGraphInjectables,
  resetGraphValueAdapter,
} from "../graph/engine-fixtures";

jest.setTimeout(60000);

const AUTH_HEADER = "authorization";

/**
 * Boots the graph module on the real for-nest auth stack: the bearer token is
 * resolved by {@link DecafAuthHandler} and bound to the request-scoped
 * `DecafRequestContext` by `AuthMiddleware`, exactly as in production.
 */
async function buildRealAuthApp(runs: GraphRunControllerOptions): Promise<{
  app: INestApplication;
  runService: GraphRunService;
}> {
  resetGraphInjectables();
  resetGraphValueAdapter();
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      DecafAuthModule.forRoot({
        global: true,
        handler: DecafAuthHandler,
      }),
      await DecafModule.forRootAsync({
        conf: [[RamAdapter, { user: "root" }, new RamTransformer()]],
        autoControllers: false,
      }),
      GraphExecutionModule.forRoot({
        // DecafModule already booted the shared RamAdapter; the graph module
        // must reuse it instead of registering a second one.
        initAdapter: false,
        runs,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  return { app, runService: moduleRef.get(GraphRunService) };
}

describe("GraphRunRealAuthOwnership (SAA-1377)", () => {
  describe("real auth binding", () => {
    it("1. DecafAuthHandler.prime binds the bearer token as the owner; an unbound Context stays undefined", async () => {
      const handler = new DecafAuthHandler();
      const bound = new Context();
      await handler.prime(
        { headers: { [AUTH_HEADER]: "Bearer alice" } } as never,
        bound as unknown as DecafRequestContext
      );

      expect(graphWorkflowOwnerOf(bound)).toBe("alice");
      expect(graphWorkflowOwnerOf(new Context())).toBeUndefined();
    });
  });

  describe("auth: optional + allowAnonymousAccess: true", () => {
    let app: INestApplication;
    let runService: GraphRunService;

    beforeAll(async () => {
      ({ app, runService } = await buildRealAuthApp({
        auth: "optional",
        allowAnonymousAccess: true,
      }));
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    const api = () => request(app.getHttpServer());

    async function createRun(): Promise<string> {
      const res = await api()
        .post("/graph/runs")
        .set(AUTH_HEADER, "Bearer alice")
        .send({ workflow: linearDocument(), inputs: { a: 1, b: 2 } });
      expect(res.status).toBe(202);
      return res.body.runId as string;
    }

    it("2. the owner reads her run, a different user is denied on status/result and events, and anonymous is tolerated", async () => {
      const runId = await createRun();
      await runService.waitForRun(runId, "alice");

      const aliceStatus = await api()
        .get(`/graph/runs/${runId}`)
        .set(AUTH_HEADER, "Bearer alice");
      expect(aliceStatus.status).toBe(200);

      const bobStatus = await api()
        .get(`/graph/runs/${runId}`)
        .set(AUTH_HEADER, "Bearer bob");
      expect(bobStatus.status).toBe(403);

      const bobEvents = await api()
        .get(`/graph/runs/${runId}/events`)
        .set(AUTH_HEADER, "Bearer bob");
      expect(bobEvents.status).toBe(403);

      // the run record carries the result payload: 403 covers both
      const bobResult = await api()
        .get(`/graph/runs/${runId}`)
        .set(AUTH_HEADER, "Bearer bob");
      expect(bobResult.status).toBe(403);

      const anonStatus = await api().get(`/graph/runs/${runId}`);
      expect(anonStatus.status).toBe(200);
    });
  });

  describe("secure defaults (auth: required, allowAnonymousAccess: false)", () => {
    let app: INestApplication;
    let runService: GraphRunService;

    beforeAll(async () => {
      ({ app, runService } = await buildRealAuthApp({
        auth: "required",
        allowAnonymousAccess: false,
      }));
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    const api = () => request(app.getHttpServer());

    it("3. an anonymous caller is denied (403) on an owned run under secure defaults", async () => {
      const createRes = await api()
        .post("/graph/runs")
        .set(AUTH_HEADER, "Bearer alice")
        .send({ workflow: linearDocument(), inputs: { a: 1, b: 2 } });
      expect(createRes.status).toBe(202);
      const runId = createRes.body.runId as string;
      await runService.waitForRun(runId, "alice");

      const ownerStatus = await api()
        .get(`/graph/runs/${runId}`)
        .set(AUTH_HEADER, "Bearer alice");
      expect(ownerStatus.status).toBe(200);

      const anonStatus = await api().get(`/graph/runs/${runId}`);
      expect(anonStatus.status).toBe(403);
    });
  });
});
