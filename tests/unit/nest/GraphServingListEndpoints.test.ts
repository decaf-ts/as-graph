/**
 * @module as-graph/tests/unit/nest/GraphServingListEndpoints.test
 * @summary SAA-76 backend coverage for the two graph serving list routes:
 * `GET /graph/workflows` ({@link GraphWorkflowController.listWorkflows})
 * and `GET /graph/workflows/:workflowId/runs`
 * ({@link GraphRunController.listRuns}).
 * @description Boots the real {@link GraphExecutionModule} through the shared
 * header-driven harness (`createGraphRunTestApp`) and exercises both routes over
 * HTTP:
 * - `GET /graph/workflows` returns the caller's visible workflow summaries
 *   (exact `{ workflowId, name?, updatedAt }` shape), newest update first,
 *   ownership-filtered (own + owner-less visible, foreign owners excluded);
 * - `GET /graph/workflows/:workflowId/runs` access-checks the workflow first
 *   (unknown → `404`, foreign owner → `403`), then returns the persisted
 *   `GraphRunModel` rows newest first, scoped to exactly the requested
 *   `workflowId` (no runs from another workflow) and ownership-filtered by run
 *   owner, with an empty array for a known workflow with no runs;
 * - the serving controllers/services resolve through the real module wiring (the
 *   new `GraphWorkflowService` constructor dependency on
 *   {@link GraphRunController}).
 *
 * The harness runs with `auth: "optional"` / `allowAnonymousAccess: true`, so the
 * ownership-filter assertions here are made for distinct *named* callers (a named
 * caller never sees another named user's resources regardless of the anonymous
 * tolerance). The `auth: "required"` 401 contract is pinned separately in
 * `GraphServingAuthRequired.test.ts`.
 *
 * NOTE (SAA-76/SAA-81): the Decaf `@date`/`@timestamp` validation binds a proxy
 * that overrides `Date.prototype.toISOString`/`toString` with the configured
 * Decaf date format (`dd/MM/yyyy HH:mm:ss:S`). The serving controllers now
 * project those proxy values to true ISO-8601 at the HTTP boundary via
 * `toIsoDateString(...)` (`src/nest/graph/servingDates.ts`), so every served
 * date assertion below pins the ISO-8601 contract.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { TestingModule } from "@nestjs/testing";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphRunService, GraphWorkflowService } from "../../../src";
import { linearDocument } from "../graph/engine-fixtures";
import {
  TEST_USER_HEADER,
  createGraphRunTestApp,
} from "./graphRunTestSupport";

jest.setTimeout(60000);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Canonical document for a uniquely-named workflow id. */
function documentWithId(id: string): GraphWorkflowDocument {
  return { ...linearDocument(), id, name: id };
}

/** Exact serving summary shape returned by `GET /graph/workflows`. */
interface WorkflowSummaryRow {
  workflowId: string;
  name?: string;
  updatedAt: string;
}

const SUMMARY_KEYS = ["name", "updatedAt", "workflowId"];
const RUN_ROW_KEYS = new Set([
  "runId",
  "workflowId",
  "owner",
  "status",
  "documentFingerprint",
  "inputs",
  "result",
  "error",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
]);
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe("Graph serving list endpoints (SAA-76)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let runService: GraphRunService;

  beforeAll(async () => {
    ({ app, moduleRef } = await createGraphRunTestApp());
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

  async function saveWorkflow(id: string, user?: string): Promise<void> {
    const req = api().put(`/graph/workflows/${id}`).send(documentWithId(id));
    if (user) req.set(TEST_USER_HEADER, user);
    const res = await req;
    expect(res.status).toBe(200);
    expect(res.body.workflowId).toBe(id);
  }

  async function createRun(workflowId: string, user?: string): Promise<string> {
    const req = api()
      .post("/graph/runs")
      .send({ workflowId, inputs: { a: 2, b: 3 } });
    if (user) req.set(TEST_USER_HEADER, user);
    const res = await req;
    expect(res.status).toBe(202);
    return res.body.runId as string;
  }

  it("1. GET /graph/workflows is an empty array on a fresh app", async () => {
    const res = await api().get("/graph/workflows");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("2. GET /graph/workflows returns the caller's workflows with the exact summary shape, newest update first", async () => {
    await saveWorkflow("list-a", "alice");
    await delay(25);
    await saveWorkflow("list-b", "alice");
    await delay(25);
    // re-saving list-a bumps its updatedAt so it becomes the newest
    await saveWorkflow("list-a", "alice");

    const res = await api()
      .get("/graph/workflows")
      .set(TEST_USER_HEADER, "alice");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const summaries = (res.body as WorkflowSummaryRow[]).filter((row) =>
      ["list-a", "list-b"].includes(row.workflowId)
    );
    // newest update first: the re-saved list-a precedes list-b
    expect(summaries.map((row) => row.workflowId)).toEqual(["list-a", "list-b"]);

    for (const summary of summaries) {
      expect(Object.keys(summary).sort()).toEqual(SUMMARY_KEYS);
      expect(typeof summary.workflowId).toBe("string");
      expect(typeof summary.name).toBe("string");
      expect(typeof summary.updatedAt).toBe("string");
      expect(summary.updatedAt).toMatch(ISO_8601);
    }
  });

  it("2b. the served summary updatedAt is ISO-8601", async () => {
    const res = await api()
      .get("/graph/workflows")
      .set(TEST_USER_HEADER, "alice");
    const summary = (res.body as WorkflowSummaryRow[]).find(
      (row) => row.workflowId === "list-a"
    ) as WorkflowSummaryRow;
    expect(summary).toBeDefined();
    expect(summary.updatedAt).toMatch(ISO_8601);
  });

  it("3. GET /graph/workflows excludes foreign-owned workflows and includes owner-less ones", async () => {
    await saveWorkflow("list-own-alice", "alice");
    await saveWorkflow("list-own-bob", "bob");
    await saveWorkflow("list-own-anon"); // no header → owner-less

    const aliceRes = await api()
      .get("/graph/workflows")
      .set(TEST_USER_HEADER, "alice");
    expect(aliceRes.status).toBe(200);
    const aliceIds = (aliceRes.body as WorkflowSummaryRow[]).map(
      (row) => row.workflowId
    );
    expect(aliceIds).toContain("list-own-alice");
    expect(aliceIds).toContain("list-own-anon");
    expect(aliceIds).not.toContain("list-own-bob");

    const bobRes = await api()
      .get("/graph/workflows")
      .set(TEST_USER_HEADER, "bob");
    expect(bobRes.status).toBe(200);
    const bobIds = (bobRes.body as WorkflowSummaryRow[]).map(
      (row) => row.workflowId
    );
    expect(bobIds).toContain("list-own-bob");
    expect(bobIds).toContain("list-own-anon");
    expect(bobIds).not.toContain("list-own-alice");
  });

  it("4. GET /graph/workflows/:workflowId/runs is 404 for an unknown workflow and [] for a known workflow with no runs", async () => {
    const unknown = await api().get("/graph/workflows/list-unknown-wf/runs");
    expect(unknown.status).toBe(404);

    await saveWorkflow("list-empty-wf");
    const empty = await api().get("/graph/workflows/list-empty-wf/runs");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
  });

  it("5. GET /graph/workflows/:workflowId/runs returns the workflow's runs newest first with the persisted row shape", async () => {
    await saveWorkflow("list-runs-wf");

    const firstRunId = await createRun("list-runs-wf");
    await runService.waitForRun(firstRunId, null);
    await delay(25);
    const secondRunId = await createRun("list-runs-wf");
    await runService.waitForRun(secondRunId, null);

    const res = await api().get("/graph/workflows/list-runs-wf/runs");
    expect(res.status).toBe(200);
    const rows = res.body as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.runId)).toEqual([secondRunId, firstRunId]);

    const row = rows[0];
    expect(row.workflowId).toBe("list-runs-wf");
    expect(typeof row.runId).toBe("string");
    expect(typeof row.status).toBe("string");
    expect(typeof row.documentFingerprint).toBe("string");
    expect(typeof row.result).toBe("object");
    expect(row.owner).toBeUndefined();
    expect(row.error).toBeUndefined();
    for (const key of ["createdAt", "updatedAt", "startedAt", "finishedAt"]) {
      expect(typeof row[key]).toBe("string");
      expect(row[key]).toMatch(ISO_8601);
    }
    for (const key of Object.keys(row)) {
      expect(RUN_ROW_KEYS.has(key)).toBe(true);
    }
    // the row is a plain JSON projection (no Date instances survive serialization)
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
  });

  it("5b. the served run-row dates are ISO-8601", async () => {
    await saveWorkflow("list-runs-iso-wf");
    const runId = await createRun("list-runs-iso-wf");
    await runService.waitForRun(runId, null);

    const res = await api().get("/graph/workflows/list-runs-iso-wf/runs");
    const row = (res.body as Record<string, unknown>[])[0];
    for (const key of ["createdAt", "updatedAt", "startedAt", "finishedAt"]) {
      expect(row[key]).toMatch(ISO_8601);
    }
  });

  it("5c. GET /graph/workflows/:workflowId/runs is scoped to exactly the requested workflow (cross-workflow isolation)", async () => {
    // SAA-91: both workflows share the same owner so ownership filtering keeps
    // every run visible; the only thing that can exclude the other workflow's
    // runs is the `workflowId` filter itself. Dropping that filter (in
    // RamGraphRunStore.listRuns / GraphRunModelService.listRuns) makes each
    // assertion below fail because it would return both workflows' runs.
    const user = "list-scope-user";
    await saveWorkflow("list-scope-wf-a", user);
    await saveWorkflow("list-scope-wf-b", user);

    const aRunId1 = await createRun("list-scope-wf-a", user);
    await runService.waitForRun(aRunId1, user);
    await delay(25);
    const aRunId2 = await createRun("list-scope-wf-a", user);
    await runService.waitForRun(aRunId2, user);
    const bRunId = await createRun("list-scope-wf-b", user);
    await runService.waitForRun(bRunId, user);

    const aRes = await api()
      .get("/graph/workflows/list-scope-wf-a/runs")
      .set(TEST_USER_HEADER, user);
    expect(aRes.status).toBe(200);
    const aRows = aRes.body as { runId: string; workflowId: string }[];
    expect(aRows.map((row) => row.runId).sort()).toEqual(
      [aRunId1, aRunId2].sort()
    );
    for (const row of aRows) {
      expect(row.workflowId).toBe("list-scope-wf-a");
    }
    expect(aRows.map((row) => row.runId)).not.toContain(bRunId);

    const bRes = await api()
      .get("/graph/workflows/list-scope-wf-b/runs")
      .set(TEST_USER_HEADER, user);
    expect(bRes.status).toBe(200);
    const bRows = bRes.body as { runId: string; workflowId: string }[];
    expect(bRows.map((row) => row.runId)).toEqual([bRunId]);
    expect(bRows[0].workflowId).toBe("list-scope-wf-b");
    expect(bRows.map((row) => row.runId)).not.toContain(aRunId1);
    expect(bRows.map((row) => row.runId)).not.toContain(aRunId2);
  });

  it("6. GET /graph/workflows/:workflowId/runs access-checks the workflow: foreign owner 403, owner 200", async () => {
    await saveWorkflow("list-foreign-wf", "alice");

    const bob = await api()
      .get("/graph/workflows/list-foreign-wf/runs")
      .set(TEST_USER_HEADER, "bob");
    expect(bob.status).toBe(403);
    expect(bob.body.message).toContain("owned by another user");

    const alice = await api()
      .get("/graph/workflows/list-foreign-wf/runs")
      .set(TEST_USER_HEADER, "alice");
    expect(alice.status).toBe(200);
    expect(alice.body).toEqual([]);
  });

  it("7. GET /graph/workflows/:workflowId/runs ownership-filters runs by run owner while keeping owner-less runs visible", async () => {
    // owner-less workflow: both alice and bob may read it, but each only sees
    // the runs they own (plus the owner-less runs)
    await saveWorkflow("list-runfilter-wf");
    const anonRunId = await createRun("list-runfilter-wf");
    await runService.waitForRun(anonRunId, null);
    await delay(25);
    const bobRunId = await createRun("list-runfilter-wf", "bob");
    await runService.waitForRun(bobRunId, "bob");

    const aliceRes = await api()
      .get("/graph/workflows/list-runfilter-wf/runs")
      .set(TEST_USER_HEADER, "alice");
    expect(aliceRes.status).toBe(200);
    const aliceRunIds = (aliceRes.body as { runId: string }[]).map(
      (row) => row.runId
    );
    expect(aliceRunIds).toContain(anonRunId);
    expect(aliceRunIds).not.toContain(bobRunId);

    const bobRes = await api()
      .get("/graph/workflows/list-runfilter-wf/runs")
      .set(TEST_USER_HEADER, "bob");
    expect(bobRes.status).toBe(200);
    const bobRunIds = (bobRes.body as { runId: string }[]).map(
      (row) => row.runId
    );
    expect(bobRunIds).toContain(bobRunId);
    expect(bobRunIds).toContain(anonRunId);
  });

  it("8. both serving routes resolve through the real GraphExecutionModule wiring", () => {
    // The controller instances are request-scoped (they inject the request-scoped
    // DecafRequestContext), so `get()` cannot pluck them directly; their
    // reachability is proven by the 200/403/404 route assertions above. The
    // services the controllers depend on — including the new GraphWorkflowService
    // dependency on GraphRunController — resolve as singletons.
    expect(moduleRef.get(GraphWorkflowService)).toBeInstanceOf(
      GraphWorkflowService
    );
    expect(moduleRef.get(GraphRunService)).toBeInstanceOf(GraphRunService);
  });
});
