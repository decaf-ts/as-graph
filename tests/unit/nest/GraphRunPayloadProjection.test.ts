/**
 * @module as-graph/tests/unit/nest/GraphRunPayloadProjection.test
 * @summary SAA-93 F1/F4 regression coverage for the run serving payload
 * projection and corrupt-date tolerance.
 * @description Boots the real {@link GraphExecutionModule} through the shared
 * header-driven harness (`createGraphRunTestApp`) and pins the SAA-85 F1 fix over
 * HTTP:
 * - `GET /graph/workflows/:workflowId/runs` keeps an owner-less run *visible*
 *   to a named caller (runId/status/dates) but omits its `inputs`/`result`/`error`
 *   payload, while an anonymous (owner-less) caller still receives the full row;
 * - `GET /graph/runs/:runId` applies the same projection, closing the
 *   list-then-read bypass;
 * - `GET /graph/runs/:runId/events` omits the SSE `payload`/`error` members for
 *   a non-owner and keeps them for the owner-less caller.
 *
 * It also pins the SAA-93 F4 corrupt-date tolerance at the HTTP boundary: a row
 * whose required date is unprojectable is skipped instead of 500ing the collection.
 *
 * The harness runs with `auth: "optional"` / `allowAnonymousAccess: true`, so both
 * named and anonymous callers are admitted; the projection — not admission — is what
 * these tests exercise.
 */
import { jest, describe, beforeAll, afterAll, afterEach, it, expect } from "@jest/globals";

import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { TestingModule } from "@nestjs/testing";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphExecutionEventType } from "../../../src/shared/graph";
import { GraphRunService, GraphWorkflowService } from "../../../src";
import { linearDocument } from "../graph/engine-fixtures";
import {
  TEST_USER_HEADER,
  createGraphRunTestApp,
  openRunEventsStream,
} from "./graphRunTestSupport";

jest.setTimeout(60000);

/** Canonical document for a uniquely-named workflow id. */
function documentWithId(id: string): GraphWorkflowDocument {
  return { ...linearDocument(), id, name: id };
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe("Graph run payload projection and corrupt-date tolerance (SAA-93 F1/F4)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let port: number;
  let runService: GraphRunService;
  let workflowService: GraphWorkflowService;

  beforeAll(async () => {
    ({ app, moduleRef, port } = await createGraphRunTestApp());
    runService = moduleRef.get(GraphRunService);
    workflowService = moduleRef.get(GraphWorkflowService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
  }

  /** Creates an owner-less (or named) run and waits for it to complete. */
  async function createRun(workflowId: string, user?: string): Promise<string> {
    const req = api()
      .post("/graph/runs")
      .send({ workflowId, inputs: { a: 2, b: 3 } });
    if (user) req.set(TEST_USER_HEADER, user);
    const res = await req;
    expect(res.status).toBe(202);
    const runId = res.body.runId as string;
    const run = await runService.waitForRun(runId, user ?? null);
    expect(run.status).toBe("succeeded");
    return runId;
  }

  /** Stubs the run list with an owner-less row carrying every payload member. */
  function stubOwnerLessRunList(): void {
    jest
      .spyOn(workflowService, "assertAccess")
      .mockResolvedValue({ workflowId: "payload-wf" } as never);
    jest.spyOn(runService, "listRunsByWorkflow").mockResolvedValue([
      {
        runId: "payload-run",
        workflowId: "payload-wf",
        status: "succeeded",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:01Z"),
        inputs: { a: 2, b: 3 },
        result: { outputs: { result: 10 } },
        error: { message: "boom" },
      },
    ] as never);
  }

  it("1. list runs as a named caller over an owner-less workflow: the row stays visible but inputs/result/error are omitted", async () => {
    stubOwnerLessRunList();

    const res = await api()
      .get("/graph/workflows/payload-wf/runs")
      .set(TEST_USER_HEADER, "alice");
    expect(res.status).toBe(200);
    const rows = res.body as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.runId).toBe("payload-run");
    expect(row.workflowId).toBe("payload-wf");
    expect(row.status).toBe("succeeded");
    expect(typeof row.createdAt).toBe("string");
    expect(row.createdAt).toMatch(ISO_8601);
    expect(typeof row.updatedAt).toBe("string");
    expect(row.inputs).toBeUndefined();
    expect(row.result).toBeUndefined();
    expect(row.error).toBeUndefined();
  });

  it("2. list runs as an anonymous (owner-less) caller keeps the full owner-less payload (no regression)", async () => {
    stubOwnerLessRunList();

    const res = await api().get("/graph/workflows/payload-wf/runs");
    expect(res.status).toBe(200);
    const rows = res.body as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.runId).toBe("payload-run");
    expect(row.inputs).toEqual({ a: 2, b: 3 });
    expect(row.result).toEqual({ outputs: { result: 10 } });
    expect(row.error).toEqual({ message: "boom" });
  });

  it("3. single read applies the same projection: a named caller gets the owner-less run summary without result/error; the owner-less caller keeps them", async () => {
    await saveWorkflow("payload-read-wf");
    const runId = await createRun("payload-read-wf");

    const aliceRes = await api()
      .get(`/graph/runs/${runId}`)
      .set(TEST_USER_HEADER, "alice");
    expect(aliceRes.status).toBe(200);
    expect(aliceRes.body.runId).toBe(runId);
    expect(aliceRes.body.status).toBe("succeeded");
    expect(typeof aliceRes.body.createdAt).toBe("string");
    expect(aliceRes.body.result).toBeUndefined();
    expect(aliceRes.body.error).toBeUndefined();

    const anonRes = await api().get(`/graph/runs/${runId}`);
    expect(anonRes.status).toBe(200);
    expect(typeof anonRes.body.result).toBe("object");
  });

  it("4. SSE envelopes omit payload/error for a non-owner; the owner-less caller keeps them", async () => {
    await saveWorkflow("payload-sse-wf");
    const runId = await createRun("payload-sse-wf");

    const nonOwner = openRunEventsStream(port, runId, {
      afterSequence: 0,
      user: "alice",
    });
    expect(await nonOwner.closed).toBe(true);
    expect(nonOwner.statusCode()).toBe(200);
    const nonOwnerTerminal = nonOwner.events.find(
      (event) => event.type === GraphExecutionEventType.WORKFLOW_COMPLETED
    );
    expect(nonOwnerTerminal).toBeDefined();
    expect(nonOwnerTerminal?.payload).toBeUndefined();
    expect(nonOwnerTerminal?.error).toBeUndefined();

    const ownerLess = openRunEventsStream(port, runId, { afterSequence: 0 });
    expect(await ownerLess.closed).toBe(true);
    expect(ownerLess.statusCode()).toBe(200);
    const ownerTerminal = ownerLess.events.find(
      (event) => event.type === GraphExecutionEventType.WORKFLOW_COMPLETED
    );
    expect(ownerTerminal).toBeDefined();
    expect(ownerTerminal?.payload).toBeDefined();
  });

  it("5. GET /graph/workflows skips a row whose updatedAt is unprojectable instead of 500ing the collection", async () => {
    jest.spyOn(workflowService, "listWorkflows").mockResolvedValue([
      {
        workflowId: "ok-wf",
        name: "ok",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        workflowId: "bad-wf",
        name: "bad",
        updatedAt: new Date("nope"),
      },
    ] as never);

    const res = await api()
      .get("/graph/workflows")
      .set(TEST_USER_HEADER, "alice");
    expect(res.status).toBe(200);
    const ids = (res.body as { workflowId: string }[]).map(
      (row) => row.workflowId
    );
    expect(ids).toEqual(["ok-wf"]);
    expect(ids).not.toContain("bad-wf");
  });

  it("6. GET /graph/workflows/:workflowId/runs skips a run row whose required createdAt/updatedAt is unprojectable", async () => {
    jest
      .spyOn(workflowService, "assertAccess")
      .mockResolvedValue({ workflowId: "corrupt-run-wf" } as never);
    jest.spyOn(runService, "listRunsByWorkflow").mockResolvedValue([
      {
        runId: "ok-run",
        workflowId: "corrupt-run-wf",
        status: "succeeded",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:01Z"),
        result: { outputs: { result: 1 } },
      },
      {
        runId: "bad-run",
        workflowId: "corrupt-run-wf",
        status: "succeeded",
        createdAt: new Date("nope"),
        updatedAt: new Date("2026-01-01T00:00:01Z"),
      },
    ] as never);

    const res = await api()
      .get("/graph/workflows/corrupt-run-wf/runs")
      .set(TEST_USER_HEADER, "alice");
    expect(res.status).toBe(200);
    const ids = (res.body as { runId: string }[]).map((row) => row.runId);
    expect(ids).toEqual(["ok-run"]);
    expect(ids).not.toContain("bad-run");
  });
});
