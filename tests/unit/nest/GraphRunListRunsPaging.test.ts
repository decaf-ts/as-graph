/**
 * @module as-graph/tests/unit/nest/GraphRunListRunsPaging.test
 * @summary SAA-888 controller-level contract for the `listRuns` metrics paging
 * parameters: `GraphRunController.parseMetricsPageParams` (400 fail-closed) and
 * the wired `MASTRA_RUN_METRICS_DELEGATION` delegation path.
 * @description Covers the two controller-level behaviours the SAA-884 review
 * gate identified as previously untested (delegation was only covered via
 * `createMastraRunMetricsDelegation` unit tests and the gateway integration):
 *
 * 1. **Paging-parameter parsing** (`GET /graph/workflows/:workflowId/runs`):
 *    `page=0`, `page=-1`, `page=abc`, `perPage=0`, `perPage=abc` each reject
 *    with `400` (`Query parameter 'page'/'perPage' must be an integer >= 1`)
 *    **before** any workflow access or run listing happens (fail closed);
 *    `page=""`/absent and `perPage=""`/absent parse to `undefined` and the
 *    request proceeds through the local fallback as the flat-array shape.
 *
 * 2. **Wired delegation path** (`src/nest/graph/GraphRunController.ts:430-464`):
 *    with a `MASTRA_RUN_METRICS_DELEGATION` provider and a mastra-owned
 *    workflow, the endpoint serves the delegation's rows / `{ data, current,
 *    total, count }` page envelope verbatim and forwards the **parsed**
 *    `page`/`perPage` numbers, short-circuiting the local run rows; with a
 *    non-mastra-owned workflow (`undefined` from the delegation) it falls back
 *    to the local run rows; a delegation `NotFoundError` (C23 foreign
 *    mastra-owned deny) maps to `404` through `graphRunHttpErrorOf`.
 *
 * Both suites boot the real controller through `@nestjs/testing` with stubbed
 * `GraphRunService`/`GraphWorkflowService` providers (same layout precedent as
 * `GraphErrorMapperNonLeakage.test.ts`), so only the controller under test is
 * exercised — no S2 source file is modified.
 */
import {
  jest,
  describe,
  beforeAll,
  beforeEach,
  afterAll,
  it,
  expect,
} from "@jest/globals";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";

import { NotFoundError } from "@decaf-ts/db-decorators";

import { GraphRunService } from "../../../src";
import { GraphWorkflowService } from "../../../src/engine/services/GraphWorkflowService";
import {
  GRAPH_RUN_OPTIONS,
  GraphRunController,
} from "../../../src/nest/graph/GraphRunController";
import {
  MASTRA_RUN_METRICS_DELEGATION,
  type MastraRunMetricsDelegation,
  type MastraRunMetricsPageHttp,
} from "../../../src/mastra/MastraRunMetricsEndpoint";

jest.setTimeout(30000);

/** Exact 400 message the `parseMetricsPageParams` contract must pin. */
const PAGE_400_MESSAGE = "Query parameter 'page' must be an integer >= 1";
const PER_PAGE_400_MESSAGE = "Query parameter 'perPage' must be an integer >= 1";

/** Stubbed `GraphRunService`: access passes, listing resolves the given rows. */
function runServiceStub(rows: Record<string, unknown>[] = []) {
  return {
    createRun: jest.fn(),
    getRun: jest.fn(),
    cancelRun: jest.fn(),
    listRunsByWorkflow: jest.fn().mockResolvedValue(rows),
  };
}

/** Stubbed `GraphWorkflowService`: the workflow access check passes. */
function workflowServiceStub() {
  return {
    assertAccess: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * A minimal persisted run row shape `graphRunModelToHttp` can project: the
 * required date members are real `Date`s, everything optional is unset, so the
 * served row carries `runId`/`workflowId`/`status`/`documentFingerprint` and
 * the ISO dates only.
 */
function localRunRow(
  workflowId: string,
  runId: string
): Record<string, unknown> {
  const now = new Date("2026-01-02T03:04:05.678Z");
  return {
    runId,
    workflowId,
    owner: undefined,
    status: "succeeded",
    documentFingerprint: `fingerprint-${runId}`,
    inputs: undefined,
    result: undefined,
    error: undefined,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: now,
  };
}

/** The delegation stub's flat mastra row and page envelope fixtures. */
const DELEGATED_FLAT_ROWS: Record<string, unknown>[] = [
  { runId: "mastra-run-1", workflowId: "wf-delegated", status: "completed" },
  { runId: "mastra-run-2", workflowId: "wf-delegated", status: "failed" },
];

const DELEGATED_PAGE: MastraRunMetricsPageHttp = {
  data: [{ runId: "mastra-run-3", workflowId: "wf-delegated", status: "completed" }],
  current: 2,
  total: 5,
  count: 11,
};

describe("GraphRunController listRuns paging contract (SAA-888)", () => {
  describe("parseMetricsPageParams: invalid page/perPage fail closed with 400, absent/empty parse to undefined", () => {
    let app: INestApplication;
    let runService: ReturnType<typeof runServiceStub>;
    let workflowService: ReturnType<typeof workflowServiceStub>;

    beforeAll(async () => {
      runService = runServiceStub();
      workflowService = workflowServiceStub();
      // No MASTRA_RUN_METRICS_DELEGATION provider: the @Optional injection
      // stays undefined, so every accepted request flows to the local
      // fallback path (flat-array shape).
      const moduleRef = await Test.createTestingModule({
        controllers: [GraphRunController],
        providers: [
          { provide: GraphRunService, useValue: runService },
          { provide: GraphWorkflowService, useValue: workflowService },
          { provide: GRAPH_RUN_OPTIONS, useValue: { auth: "optional" } },
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    const api = () => request(app.getHttpServer());

    beforeEach(() => {
      runService.listRunsByWorkflow.mockClear();
      workflowService.assertAccess.mockClear();
    });

    it("1. page=0 is rejected with 400 and the page contract message", async () => {
      const res = await api().get("/graph/workflows/wf-paging/runs?page=0");
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(PAGE_400_MESSAGE);
    });

    it("2. page=-1 is rejected with 400", async () => {
      const res = await api().get("/graph/workflows/wf-paging/runs?page=-1");
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(PAGE_400_MESSAGE);
    });

    it("3. page=abc is rejected with 400", async () => {
      const res = await api().get("/graph/workflows/wf-paging/runs?page=abc");
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(PAGE_400_MESSAGE);
    });

    it("4. perPage=0 is rejected with 400 and the perPage contract message", async () => {
      const res = await api().get("/graph/workflows/wf-paging/runs?perPage=0");
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(PER_PAGE_400_MESSAGE);
    });

    it("5. perPage=abc is rejected with 400", async () => {
      const res = await api().get("/graph/workflows/wf-paging/runs?perPage=abc");
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(PER_PAGE_400_MESSAGE);
    });

    it("6. perPage=-3 is rejected with 400", async () => {
      const res = await api().get("/graph/workflows/wf-paging/runs?perPage=-3");
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(PER_PAGE_400_MESSAGE);
    });

    it("7. an invalid parameter fails closed before any workflow access or run listing", async () => {
      const res = await api().get(
        "/graph/workflows/wf-paging/runs?page=abc&perPage=5"
      );
      expect(res.status).toBe(400);
      expect(workflowService.assertAccess).not.toHaveBeenCalled();
      expect(runService.listRunsByWorkflow).not.toHaveBeenCalled();
    });

    it("8. absent page/perPage parse to undefined and serve the flat-array fallback shape", async () => {
      const res = await api().get("/graph/workflows/wf-paging/runs");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(workflowService.assertAccess).toHaveBeenCalled();
      expect(runService.listRunsByWorkflow).toHaveBeenCalled();
    });

    it("9. page=\"\" and perPage=\"\" parse to undefined and serve the flat-array fallback shape", async () => {
      const res = await api().get(
        "/graph/workflows/wf-paging/runs?page=&perPage="
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(workflowService.assertAccess).toHaveBeenCalled();
      expect(runService.listRunsByWorkflow).toHaveBeenCalled();
    });

    it("10. valid page=2&perPage=5 passes parsing and serves the flat-array fallback shape", async () => {
      const res = await api().get(
        "/graph/workflows/wf-paging/runs?page=2&perPage=5"
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("wired MASTRA_RUN_METRICS_DELEGATION delegation path", () => {
    let app: INestApplication;
    let runService: ReturnType<typeof runServiceStub>;
    let workflowService: ReturnType<typeof workflowServiceStub>;
    let delegation: { listRuns: jest.Mock };

    beforeAll(async () => {
      runService = runServiceStub([localRunRow("wf-fallback", "local-run-1")]);
      workflowService = workflowServiceStub();
      delegation = {
        listRuns: jest.fn(),
      };
      const moduleRef = await Test.createTestingModule({
        controllers: [GraphRunController],
        providers: [
          { provide: GraphRunService, useValue: runService },
          { provide: GraphWorkflowService, useValue: workflowService },
          { provide: GRAPH_RUN_OPTIONS, useValue: { auth: "optional" } },
          {
            provide: MASTRA_RUN_METRICS_DELEGATION,
            useValue: delegation as unknown as MastraRunMetricsDelegation,
          },
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    const api = () => request(app.getHttpServer());

    beforeEach(() => {
      runService.listRunsByWorkflow.mockClear();
      workflowService.assertAccess.mockClear();
      delegation.listRuns.mockClear();
    });

    it("11. a mastra-owned workflow with page/perPage serves the delegation's page envelope and forwards the parsed numbers", async () => {
      delegation.listRuns.mockResolvedValueOnce(DELEGATED_PAGE);

      const res = await api().get(
        "/graph/workflows/wf-delegated/runs?page=2&perPage=5"
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual(DELEGATED_PAGE);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.current).toBe(2);
      expect(res.body.total).toBe(5);
      expect(res.body.count).toBe(11);
      expect(delegation.listRuns).toHaveBeenCalledWith(
        "wf-delegated",
        null,
        2,
        5
      );
      // the delegation result short-circuits the local run rows
      expect(workflowService.assertAccess).not.toHaveBeenCalled();
      expect(runService.listRunsByWorkflow).not.toHaveBeenCalled();
    });

    it("12. a mastra-owned workflow without paging parameters forwards undefined page/perPage and serves the flat array shape", async () => {
      delegation.listRuns.mockResolvedValueOnce(DELEGATED_FLAT_ROWS);

      const res = await api().get("/graph/workflows/wf-delegated/runs");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toEqual(DELEGATED_FLAT_ROWS);
      expect(delegation.listRuns).toHaveBeenCalledWith(
        "wf-delegated",
        null,
        undefined,
        undefined
      );
    });

    it("13. empty-string page/perPage are forwarded as undefined (parsed, not raw) to the delegation", async () => {
      delegation.listRuns.mockResolvedValueOnce(DELEGATED_FLAT_ROWS);

      const res = await api().get(
        "/graph/workflows/wf-delegated/runs?page=&perPage="
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(delegation.listRuns).toHaveBeenCalledWith(
        "wf-delegated",
        null,
        undefined,
        undefined
      );
    });

    it("14. a non-mastra-owned workflow (delegation returns undefined) falls back to the local run rows", async () => {
      delegation.listRuns.mockResolvedValueOnce(undefined);

      const res = await api().get("/graph/workflows/wf-fallback/runs");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const rows = res.body as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].runId).toBe("local-run-1");
      expect(rows[0].workflowId).toBe("wf-fallback");
      expect(typeof rows[0].createdAt).toBe("string");
      expect(workflowService.assertAccess).toHaveBeenCalledWith(
        "wf-fallback",
        undefined
      );
      expect(runService.listRunsByWorkflow).toHaveBeenCalled();
    });

    it("15. the fallback still applies after parsed paging parameters (page=1&perPage=1)", async () => {
      delegation.listRuns.mockResolvedValueOnce(undefined);

      const res = await api().get(
        "/graph/workflows/wf-fallback/runs?page=1&perPage=1"
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(delegation.listRuns).toHaveBeenCalledWith(
        "wf-fallback",
        null,
        1,
        1
      );
      expect(runService.listRunsByWorkflow).toHaveBeenCalled();
    });

    it("16. a delegation NotFoundError (C23 foreign mastra-owned deny) maps to 404", async () => {
      delegation.listRuns.mockRejectedValueOnce(
        new NotFoundError("Workflow wf-foreign is not visible")
      );

      const res = await api().get("/graph/workflows/wf-foreign/runs");
      expect(res.status).toBe(404);
      expect(res.body.message).toContain("wf-foreign");
      expect(runService.listRunsByWorkflow).not.toHaveBeenCalled();
    });
  });
});
