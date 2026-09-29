/**
 * @module as-graph/tests/unit/nest/GraphResultsOwnership
 * @summary SAA-595 F1 regression tests: ownership-gated run/result reads.
 * @description Boots {@link GraphExecutionModule} with `runs.auth` set to
 * `"optional"` but WITHOUT the DECAF-48 §4.15 anonymous tolerance
 * (`allowAnonymousAccess` stays `false`, SAA-595 F3 fail-closed default) and
 * pins the ownership behaviour of the asynchronous run surface:
 * - a run created for an owned caller is denied to a different user (403) and
 *   to an anonymous caller (403, fail-closed) on `GET /graph/runs/:runId`
 *   (which carries the run's result payload);
 * - the owner reads the full run and result body (inputs/outputs/nodeResults);
 * - owner-less (legacy/anonymous) runs stay readable by anonymous callers.
 *
 * The run is created through the canonical `POST /graph/runs` lifecycle API
 * (the deprecated synchronous `POST /graph/execute` surface was removed,
 * SAA-1950 F4); the result travels inside the persisted run record.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { TestingModule } from "@nestjs/testing";

import { GraphRunService } from "../../../src";
import { GraphExecutionModule } from "../../../src/nest/graph";
import { linearDocument } from "../graph/engine-fixtures";
import { TEST_USER_HEADER, TestRequestContextModule } from "./graphRunTestSupport";

jest.setTimeout(60000);

describe("GraphResultsOwnership (SAA-595 F1 regression)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let runService: GraphRunService;
  let port: number;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TestRequestContextModule,
        // No `allowAnonymousAccess`: the §4.15 tolerance stays OFF so the
        // fail-closed default (F3) is exactly what these tests exercise.
        // `initAdapter: true` installs the standalone RamAdapter (F3).
        GraphExecutionModule.forRoot({
          initAdapter: true,
          runs: { auth: "optional" },
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    runService = moduleRef.get(GraphRunService);
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") {
      throw new Error("Could not determine the ephemeral test HTTP port");
    }
    port = address.port;
  });

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // already closed
    }
  });

  const api = () => request(app.getHttpServer());

  /** Creates and completes the linear document as the given user (or anonymously), returning the runId. */
  async function executeAs(
    user: string | null,
    inputs: Record<string, number> = { a: 3, b: 4 }
  ): Promise<string> {
    const res = await (user
      ? api().post("/graph/runs").set(TEST_USER_HEADER, user)
      : api().post("/graph/runs")
    ).send({ workflow: linearDocument(), inputs });
    expect(res.status).toBe(202);
    const runId = res.body.runId as string;
    const run = await runService.waitForRun(runId, user);
    expect(run.status).toBe("succeeded");
    return runId;
  }

  it("1. owned run: a different user gets 403 before any result data is read", async () => {
    const runId = await executeAs("alice");

    const res = await api()
      .get(`/graph/runs/${runId}`)
      .set(TEST_USER_HEADER, "bob");

    expect(res.status).toBe(403);
    expect(res.body.message).toContain(runId);
    expect(res.body.message).toContain("owned by another user");
  });

  it("2. owned run: an anonymous caller gets 403 (fail-closed without the §4.15 tolerance)", async () => {
    const runId = await executeAs("alice");

    const res = await api().get(`/graph/runs/${runId}`);

    expect(res.status).toBe(403);
    expect(res.body.message).toContain("owned by another user");
  });

  it("3. owned run: the owner gets 200 with the correct inputs, outputs and nodeResults", async () => {
    const runId = await executeAs("alice", { a: 6, b: 7 });

    const res = await api()
      .get(`/graph/runs/${runId}`)
      .set(TEST_USER_HEADER, "alice");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
    expect(res.body.workflowId).toBe("linear-wf");
    expect(res.body.status).toBe("succeeded");
    expect(res.body.result.inputs).toEqual({ a: 6, b: 7 });
    expect(res.body.result.outputs.result).toBe(26); // (6 + 7) * 2
    expect(Object.keys(res.body.result.nodeResults).sort()).toEqual([
      "adder",
      "multiplier",
    ]);
  });

  it("4. owner-less (legacy) run: an anonymous caller still gets 200", async () => {
    // Created without a resolved identity: no `ownerUser`, matching legacy
    // rows persisted before the SAA-595 F1 owner stamp existed.
    const runId = await executeAs(null, { a: 1, b: 2 });

    const res = await api().get(`/graph/runs/${runId}`);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
    expect(res.body.result.outputs.result).toBe(6); // (1 + 2) * 2
  });

  it("5. cross-user denial holds for the run-scoped surface too: bob gets 403 on GET /graph/runs/:runId and its event stream", async () => {
    const runId = await executeAs("alice");

    const bobRun = await api()
      .get(`/graph/runs/${runId}`)
      .set(TEST_USER_HEADER, "bob");
    expect(bobRun.status).toBe(403);

    const bobEvents = await api()
      .get(`/graph/runs/${runId}/events`)
      .set(TEST_USER_HEADER, "bob");
    expect(bobEvents.status).toBe(403);

    // sanity: the ephemeral port wiring is live for the anonymous-tolerated
    // ownerless case (guards against a false-positive from a dead server)
    expect(port).toBeGreaterThan(0);
  });
});
