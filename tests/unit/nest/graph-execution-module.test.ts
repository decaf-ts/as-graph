/**
 * @module as-graph/tests/unit/nest/graph-execution-module.test
 * @summary Unit tests for the NestJS graph execution backend module.
 * @description Bootstraps {@link GraphExecutionModule} via `@nestjs/testing`
 * and validates the DECAF-50 §4.20 P7 cutover defaults on the canonical
 * asynchronous run surface (the deprecated synchronous `POST /graph/execute`,
 * `GET /graph/results/:runId` and `PUT /graph/workflow/:id` shim was removed,
 * SAA-1950 F4):
 * - `POST /graph/runs` executes a canonical `GraphWorkflowDocument` and the
 *   terminal run carries the correct result.
 * - Legacy `GraphWorkflowDefinition` payloads (and snapshot wrappers) are
 *   rejected at the boundary with a Decaf `ValidationError` — the
 *   flag-independent default (§4.16 inline-definition rejection).
 * - `GET /graph/runs/:runId` retrieves the persisted run and its result.
 * - `PUT /graph/workflows/:id` accepts canonical wrapper snapshots only.
 * - The dynamic module wires `ThrottlerModule` and the `APP_GUARD`
 *   `ThrottlerGuard` (SAA-1950 F7).
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";

import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { TestingModule } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";

import { ValidationError } from "@decaf-ts/db-decorators";
import type { GraphWorkflowDefinition } from "../../../src/shared/graph";

import { type GraphExecutionValues, GraphRunService } from "../../../src";

import { GraphExecutionModule } from "../../../src/nest/graph";
import { GraphWorkflowService } from "../../../src";
import { linearDocument } from "../graph/engine-fixtures";
import { TestRequestContextModule } from "./graphRunTestSupport";

/**
 * Builds a legacy decorated-era `GraphWorkflowDefinition` payload (the
 * pre-DECAF-50 execution request shape). Post-cutover this payload MUST be
 * rejected by the run boundary (§4.16/§4.20 P7).
 */
function buildLegacyWorkflowDefinition(): GraphWorkflowDefinition {
  return {
    name: "linear-wf",
    tag: "linear-wf",
    kind: "workflow",
    labels: [],
    ports: [],
    inputs: [],
    outputs: [],
    nodes: [
      { id: "adder", kind: "math.add", label: "Adder" },
      { id: "multiplier", kind: "math.multiply", label: "Multiplier" },
    ],
    relations: [
      { source: "adder", sourcePort: "sum", target: "multiplier", targetPort: "x" },
    ],
    workflow: { inputs: [], outputs: [] },
  } as unknown as GraphWorkflowDefinition;
}

jest.setTimeout(30000);

describe("GraphExecutionModule (unit)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let runService: GraphRunService;
  let workflowService: GraphWorkflowService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TestRequestContextModule,
        // SAA-1950 F3: `initAdapter` defaults to `false`; this standalone
        // suite installs the RamAdapter explicitly. SAA-93 F2 made the
        // default `auth: "required"` gate reject a context with no resolved
        // owner user with 401, so this cutover suite opts into the
        // anonymous/standalone tolerance explicitly (SAA-93 F3: the tolerance
        // is a service option supplied through the intersected module options).
        GraphExecutionModule.forRoot({
          initAdapter: true,
          runs: { auth: "optional", allowAnonymousAccess: true },
          workflows: { auth: "optional", allowAnonymousAccess: true },
        }),
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    runService = moduleRef.get(GraphRunService);
    workflowService = moduleRef.get(GraphWorkflowService);
  }, 15000);

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // already closed
    }
  }, 15000);

  const api = () => request(app.getHttpServer());

  it("executes a canonical document and the terminal run carries the correct result", async () => {
    const workflow = linearDocument();
    const inputs: GraphExecutionValues = { a: 3, b: 4 };

    const res = await api().post("/graph/runs").send({ workflow, inputs });
    expect(res.status).toBe(202);
    const runId = res.body.runId as string;

    const run = await runService.waitForRun(runId, null);
    expect(run.status).toBe("succeeded");
    expect(run.result?.outputs.result).toBe(14); // (3 + 4) * 2
  });

  it("P7 §4.16 security pin (payload level, flag-independent default): legacy GraphWorkflowDefinition payloads to POST /graph/runs are rejected with a Decaf ValidationError", async () => {
    const legacy = buildLegacyWorkflowDefinition();

    // Run service contract: the boundary rejects the legacy payload with a
    // Decaf ValidationError before the engine or planner sees it.
    await expect(
      runService.createRun({ workflow: legacy as never, inputs: {} }, null)
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      runService.createRun({ workflow: legacy as never, inputs: {} }, null)
    ).rejects.toThrow(/canonical GraphWorkflowDocument/);

    // Snapshot wrappers are non-canonical payloads too and are rejected.
    const wrapper = { document: linearDocument(), metadata: {} };
    await expect(
      runService.createRun({ workflow: wrapper as never, inputs: {} }, null)
    ).rejects.toBeInstanceOf(ValidationError);

    // HTTP surface: the legacy payload never executes — the request fails
    // without running a workflow or persisting a run.
    const execRes = await api()
      .post("/graph/runs")
      .send({ workflow: legacy, inputs: { a: 3, b: 4 } });
    expect(execRes.status).toBeGreaterThanOrEqual(400);
    expect(execRes.body.runId).toBeUndefined();
  });

  it("persists the terminal run and retrieves it via GET /graph/runs/:runId", async () => {
    const workflow = linearDocument();
    const inputs: GraphExecutionValues = { a: 7, b: 8 };

    const execRes = await api().post("/graph/runs").send({ workflow, inputs });
    expect(execRes.status).toBe(202);
    const runId = execRes.body.runId as string;
    await runService.waitForRun(runId, null);

    const res = await api().get(`/graph/runs/${runId}`);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
    expect(res.body.workflowId).toBe("linear-wf");
    expect(res.body.status).toBe("succeeded");
    expect(res.body.result.outputs.result).toBe(30); // (7 + 8) * 2
    expect(res.body.result.inputs).toEqual(inputs);
  });

  it("GET /graph/runs/:runId returns 404 for unknown runId", async () => {
    const res = await api().get("/graph/runs/nonexistent-run-id");

    expect(res.status).toBe(404);
  });

  it("PUT /graph/workflows/:id accepts only canonical wrapper snapshots (legacy definition/state snapshots are rejected)", async () => {
    // Legacy definition/state snapshot payloads are rejected (§4.11 P7).
    const legacySnapshot = {
      state: { nodes: [], edges: [] },
      metadata: { serializedAt: "2024-01-01" },
    };
    const legacyRes = await api()
      .put("/graph/workflows/test-wf-1")
      .send(legacySnapshot);
    expect(legacyRes.status).toBeGreaterThanOrEqual(400);
    expect(await workflowService.loadSnapshot("test-wf-1")).toBeNull();

    // Canonical wrapper snapshots round-trip: the wrapper is stored and
    // `getDocument` prefers the canonical document column.
    const wrapper = {
      document: linearDocument(),
      metadata: { serializedAt: "2024-01-01" },
    };
    const res = await api()
      .put("/graph/workflows/linear-wf")
      .send(wrapper);

    expect(res.status).toBe(200);
    expect(res.body.workflowId).toBe("linear-wf");
    expect(res.body.savedAt).toBeTruthy();

    // Verify via the service
    const persisted = await workflowService.loadSnapshot("linear-wf");
    expect(persisted).toBeTruthy();
    expect(persisted!.workflowId).toBe("linear-wf");
    expect(persisted!.snapshot).toEqual(wrapper);
    expect(persisted!.document).toEqual(wrapper.document);
    expect(await workflowService.getDocument("linear-wf")).toEqual(
      wrapper.document
    );
  });

  it("F7: the dynamic module imports ThrottlerModule and provides ThrottlerGuard as APP_GUARD", () => {
    const dynamic = GraphExecutionModule.forRoot({ initAdapter: true });

    const throttlerImport = (dynamic.imports ?? []).find(
      (entry) => (entry as { module?: unknown })?.module === ThrottlerModule
    );
    expect(throttlerImport).toBeDefined();

    const guardProvider = (dynamic.providers ?? []).find(
      (entry) => (entry as { provide?: unknown })?.provide === APP_GUARD
    );
    expect(guardProvider).toBeDefined();
    expect((guardProvider as { useClass?: unknown }).useClass).toBe(
      ThrottlerGuard
    );
  });

  it("does not register the removed synchronous execute/results controller or global event stream", async () => {
    // The deprecated GraphExecutionController (POST /graph/execute,
    // GET /graph/results/:runId) was removed (SAA-1950 F4): those routes
    // are no longer served.
    const execute = await api().post("/graph/execute").send({});
    expect(execute.status).toBe(404);

    const results = await api().get("/graph/results/anything");
    expect(results.status).toBe(404);

    const globalEvents = await api().get("/graph/events");
    expect(globalEvents.status).toBe(404);
  });
});
