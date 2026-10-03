/**
 * @module as-graph/tests/unit/nest/GraphRunListStoreErrorPropagation.test
 * @summary SAA-93 R1 regression coverage: the production run-list path must not
 * mask a store outage as an empty `200`.
 * @description `RamGraphRunStore.listRuns` is the store
 * `GraphExecutionModule` actually injects into
 * `GraphRunService.listRunsByWorkflow`, which backs
 * `GET /graph/workflows/:workflowId/runs`. Before SAA-93 R1 it swallowed every
 * adapter failure into `[]`, so a storage outage surfaced as `200 []`.
 *
 * The tests boot the real `GraphExecutionModule` over a Ram adapter whose query
 * execution (`raw`, reached through the Decaf repository's `findBy` statement)
 * rejects. This drives the real `RamGraphRunStore.listRuns` body — not a stubbed
 * store method and not the `GraphRunModelService` path — so:
 * - `RamGraphRunStore.listRuns` propagates the adapter failure;
 * - `GraphRunService.listRunsByWorkflow` (the service the controller injects)
 *   propagates it;
 * - `GET /graph/workflows/:workflowId/runs` answers `500`, not `200 []`.
 *
 * The workflow row itself is served by the working value adapter (installed by
 * `initAdapter: true`), so the workflow access check succeeds and only the run
 * list query fails.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { TestingModule } from "@nestjs/testing";
import { Test } from "@nestjs/testing";

import { GraphRunService } from "../../../src/engine/runs/GraphRunService";
import { RamGraphRunStore } from "../../../src/ram";
import { GraphExecutionModule } from "../../../src/nest/graph";
import { linearDocument } from "../graph/engine-fixtures";
import { TestRequestContextModule } from "./graphRunTestSupport";

jest.setTimeout(60000);

const WORKFLOW_ID = "saa-103-wf";

describe("Graph run-list store-error propagation on the production path (SAA-93 R1)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let runService: GraphRunService;
  let runStore: RamGraphRunStore;
  let findBySpy: jest.SpyInstance;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TestRequestContextModule,
        GraphExecutionModule.forRoot({
          initAdapter: true,
          runs: { auth: "optional", allowAnonymousAccess: true },
          workflows: { auth: "optional", allowAnonymousAccess: true },
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);

    runService = moduleRef.get(GraphRunService);
    runStore = moduleRef.get(RamGraphRunStore);

    // The workflow row is served by the working value adapter, so `assertAccess`
    // succeeds and only the run-list store call fails.
    const saved = await request(app.getHttpServer())
      .put(`/graph/workflows/${WORKFLOW_ID}`)
      .send({ ...linearDocument(), id: WORKFLOW_ID, name: WORKFLOW_ID });
    expect(saved.status).toBe(200);

    // Fail the storage boundary the store's `findBy` reaches. The real
    // `RamGraphRunStore.listRuns` body still runs: only the repository query
    // rejects, exactly as a durable adapter outage does.
    const repo = (runStore as unknown as {
      repo: { findBy: (...args: unknown[]) => Promise<unknown> };
    }).repo;
    findBySpy = jest
      .spyOn(repo, "findBy")
      .mockRejectedValue(new Error("run store down") as never);
  });

  afterAll(async () => {
    findBySpy.mockRestore();
    try {
      await app.close();
    } catch {
      // already closed
    }
  });

  it("1. RamGraphRunStore.listRuns propagates the adapter failure instead of returning []", async () => {
    await expect(runStore.listRuns(WORKFLOW_ID)).rejects.toThrow(
      /run store down/
    );
  });

  it("2. GraphRunService.listRunsByWorkflow propagates the store failure", async () => {
    await expect(
      runService.listRunsByWorkflow(WORKFLOW_ID, null)
    ).rejects.toThrow(/run store down/);
  });

  it("3. GET /graph/workflows/:workflowId/runs answers 500, not a masked 200 []", async () => {
    const res = await request(app.getHttpServer()).get(
      `/graph/workflows/${WORKFLOW_ID}/runs`
    );
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(200);
  });
});
