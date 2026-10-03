/**
 * @module as-graph/tests/unit/nest/GraphSecureDefaults
 * @summary SAA-595 regression tests: fail-closed module defaults (scenario 1
 * of the SAA-608 review follow-up).
 * @description Boots {@link GraphExecutionModule} with only the adapter
 * bootstrapped (`initAdapter: true`, SAA-1950 F3) — NO auth options — next
 * to the header-driven test request context, and pins the secure defaults the
 * SAA-595 hardening introduced: a run created by an authenticated user
 * (alice) is readable only by its owner — an anonymous caller is rejected
 * `401` before ownership is even checked (SAA-93 F2: `auth: "required"` now
 * requires a *resolved owner*, not merely a request context) and another user
 * (bob) gets `403` on the run status, the run event stream, and the run
 * result. Without the DECAF-48 §4.15 `allowAnonymousAccess` tolerance,
 * ownership checks fail closed.
 *
 * This suite deliberately does NOT reuse `createGraphRunTestApp`: that
 * harness opts into `allowAnonymousAccess: true`, which is exactly the
 * tolerance these defaults must NOT carry.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";

import { GraphRunService } from "../../../src";
import { GraphExecutionModule } from "../../../src/nest/graph";
import { linearDocument } from "../graph/engine-fixtures";
import { TEST_USER_HEADER, TestRequestContextModule } from "./graphRunTestSupport";

jest.setTimeout(60000);

describe("GraphSecureDefaults (SAA-595 fail-closed defaults, bare forRoot)", () => {
  let app: INestApplication;
  let runService: GraphRunService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TestRequestContextModule,
        // No auth options: runs.auth defaults to "required" and, critically,
        // allowAnonymousAccess stays false (fail-closed). `initAdapter: true`
        // installs the standalone RamAdapter (SAA-1950 F3).
        GraphExecutionModule.forRoot({ initAdapter: true }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    runService = moduleRef.get(GraphRunService);
  });

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // already closed
    }
  });

  const api = () => request(app.getHttpServer());

  it("1. an owned run is denied to anonymous callers and other users on status, events, and result", async () => {
    // alice creates a run through the run lifecycle API
    const createRes = await api()
      .post("/graph/runs")
      .set(TEST_USER_HEADER, "alice")
      .send({ workflow: linearDocument(), inputs: { a: 1, b: 2 } });
    expect(createRes.status).toBe(202);
    const runId = createRes.body.runId as string;
    await runService.waitForRun(runId, "alice");

    // sanity: the owner still reads her own run
    const aliceStatus = await api()
      .get(`/graph/runs/${runId}`)
      .set(TEST_USER_HEADER, "alice");
    expect(aliceStatus.status).toBe(200);
    expect(aliceStatus.body.status).toBe("succeeded");

    // anonymous (no x-test-user): 401 on all three surfaces. SAA-93 F2: the
    // request context exists (the test module installs it for every request)
    // but carries no resolved owner user, so the required-auth gate rejects
    // before the ownership check can return 403.
    const anonStatus = await api().get(`/graph/runs/${runId}`);
    expect(anonStatus.status).toBe(401);
    expect(anonStatus.body.message).toContain("requires an authenticated user");

    const anonEvents = await api().get(`/graph/runs/${runId}/events`);
    expect(anonEvents.status).toBe(401);

    // the result is carried by the run status payload: 401 there covers it
    const anonResult = await api().get(`/graph/runs/${runId}`);
    expect(anonResult.status).toBe(401);
    expect(anonResult.body.message).toContain("requires an authenticated user");

    // bob: 403 on all three surfaces
    const bobStatus = await api()
      .get(`/graph/runs/${runId}`)
      .set(TEST_USER_HEADER, "bob");
    expect(bobStatus.status).toBe(403);

    const bobEvents = await api()
      .get(`/graph/runs/${runId}/events`)
      .set(TEST_USER_HEADER, "bob");
    expect(bobEvents.status).toBe(403);

    const bobResult = await api()
      .get(`/graph/runs/${runId}`)
      .set(TEST_USER_HEADER, "bob");
    expect(bobResult.status).toBe(403);
  });

  it("2. GET /graph/workflows rejects an owner-less (anonymous) caller with 401 under the required defaults", async () => {
    // The request context exists (the test module installs it for every
    // request) but carries no resolved owner user: the SAA-93 F2 required
    // gate rejects before the owner-less visibility contract can serve 200.
    const anon = await api().get("/graph/workflows");
    expect(anon.status).toBe(401);
    expect(anon.body.message).toContain("requires an authenticated user");

    // a resolved owner still gets the owner-less collection
    const alice = await api()
      .get("/graph/workflows")
      .set(TEST_USER_HEADER, "alice");
    expect(alice.status).toBe(200);
  });
});
