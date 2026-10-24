/**
 * @module as-graph/tests/integration/graph/DagsterEtlPipelineRunnableContract.test
 * @summary SAA-1359 D5 contract: the row marked `runnable:true` for the Dagster
 * deployment (`etl_pipeline`) is exactly the row the engine can execute.
 * @description Boots the real `GraphExecutionEngine` over the real
 * `DagsterGraphExecutionBackend` with a scripted gateway port and an EMPTY node
 * catalogue (it does not register the deployment's `dagster.op` kind). With the
 * execution gate on, the catalogue marks `etl_pipeline` runnable, `getWorkflow`
 * projects its deployed ops into a deployment document, and `execute` accepts
 * that projection (SAA-1384 deployment validation) and launches the deployed job
 * to a terminal. With the gate off, the same row is `runnable:false` and the run
 * path fails closed before any launch. Seeded fixture rows stay non-runnable in
 * both modes. No HTTP is mocked; the in-memory port is the only substitute for a
 * live Dagster webserver.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import request from "supertest";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { DagsterGraphExecutionBackend } from "../../../src/dagster/DagsterGraphExecutionBackend";
import { DAGSTER_ERROR } from "../../../src/dagster/constants";
import type { DagsterJobRecord } from "../../../src/dagster/DagsterTypes";
import { GraphExecutionModule } from "../../../src/nest/graph";
import { bootEngine, freshCatalogue } from "../../unit/graph/engine-fixtures";
import { FakeDagsterClient } from "../../unit/graph/dagster/dagster-fixtures";
import { TestRequestContextModule } from "../../unit/nest/graphRunTestSupport";
import { dagsterClient, dagsterIntegrationDescribe } from "../dagster/helpers";

const ETL_JOB: DagsterJobRecord = {
  name: "etl_pipeline",
  description: "three-op linear extract -> transform -> load job",
  ops: [
    { name: "extract", nodeId: "extract", outputs: ["result"] },
    {
      name: "transform",
      nodeId: "transform",
      inputs: ["value"],
      outputs: ["result"],
    },
    { name: "load", nodeId: "load", inputs: ["value"] },
  ],
  dependencies: [
    { from: "extract", to: "transform" },
    { from: "transform", to: "load" },
  ],
};

const ETL_EVENTS = [
  { type: "STEP_START", stepKey: "extract" },
  { type: "STEP_SUCCESS", stepKey: "extract" },
  { type: "STEP_START", stepKey: "transform" },
  { type: "STEP_SUCCESS", stepKey: "transform" },
  { type: "STEP_START", stepKey: "load" },
  { type: "STEP_SUCCESS", stepKey: "load" },
];

/** A read-only seeded canonical fixture; it must never become runnable. */
function seededFixture(id: string): GraphWorkflowDocument {
  return {
    id,
    name: id,
    inputs: [],
    outputs: [],
    nodes: [],
    edges: [],
    metadata: { seededFixture: true } as GraphWorkflowDocument["metadata"],
  };
}

/** Builds a scripted client serving `etl_pipeline`, optionally launchable. */
function etlClient(executionEnabled: boolean): FakeDagsterClient {
  return new FakeDagsterClient(
    ETL_EVENTS,
    { runId: "etl-run", status: "success", outputs: {} },
    [{ name: "etl_pipeline" }],
    { etl_pipeline: ETL_JOB },
    executionEnabled
      ? { launchRunId: "etl-run", runJobNames: { "etl-run": "etl_pipeline" } }
      : {}
  );
}

/** Boots the engine over the Dagster backend with a catalogue that lacks `dagster.op`. */
async function bootDagsterEngine(executionEnabled: boolean): Promise<{
  backend: DagsterGraphExecutionBackend;
  client: FakeDagsterClient;
  catalogue: ReturnType<typeof freshCatalogue>;
  engine: Awaited<ReturnType<typeof bootEngine>>;
}> {
  const client = etlClient(executionEnabled);
  const backend = new DagsterGraphExecutionBackend();
  await backend.initialize({ client, executionEnabled });
  await backend.seedWorkflows([seededFixture("fixture-manual-log")]);

  const catalogue = freshCatalogue();
  const engine = await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    catalogue,
    backend,
  });
  return { backend, client, catalogue, engine };
}

describe("Dagster etl_pipeline runnable contract (SAA-1359 D5)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("gate ON: runnable:true etl_pipeline projects and executes through the engine", async () => {
    const { backend, client, catalogue, engine } =
      await bootDagsterEngine(true);

    // The catalogue intentionally does not know the deployment kind: deployment
    // projection leniency (SAA-1384) is what lets the run pass validation.
    expect(catalogue.has("dagster.op")).toBe(false);
    expect(engine.backend.documentValidation).toBe("deployment");

    const rows = await engine.listWorkflows();
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: "etl_pipeline", name: "etl_pipeline", runnable: true },
        {
          id: "fixture-manual-log",
          name: "fixture-manual-log",
          runnable: false,
        },
      ])
    );

    const document = await engine.getWorkflow("etl_pipeline");
    expect(document.id).toBe("etl_pipeline");
    expect(document.nodes.map((node) => node.id)).toEqual([
      "extract",
      "transform",
      "load",
    ]);
    for (const node of document.nodes) {
      expect(node.kind).toBe("dagster.op");
    }

    const result = await engine.execute(
      document,
      {},
      { runId: "etl-contract-run" }
    );

    expect(result.status).toBe("succeeded");
    expect(result.workflowId).toBe("etl_pipeline");
    expect(Object.keys(result.nodeResults).sort()).toEqual([
      "extract",
      "load",
      "transform",
    ]);
    for (const nodeId of ["extract", "transform", "load"]) {
      expect(result.nodeResults[nodeId].status).toBe("succeeded");
    }
    expect(client.launched.map((launched) => launched.jobName)).toEqual([
      "etl_pipeline",
    ]);

    await backend.dispose();
  });

  it("gate OFF: etl_pipeline is runnable:false and the run fails closed before launch", async () => {
    const { backend, client, engine } = await bootDagsterEngine(false);

    const rows = await engine.listWorkflows();
    const etl = rows.find((row) => row.id === "etl_pipeline");
    expect(etl).toMatchObject({ runnable: false });
    expect(rows.find((row) => row.id === "fixture-manual-log")?.runnable).toBe(
      false
    );

    const document = await engine.getWorkflow("etl_pipeline");

    await expect(
      engine.execute(document, {}, { runId: "etl-contract-gate-off" })
    ).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.EXECUTION_NOT_ENABLED,
    });

    // The gate is checked before any launch: no run was created.
    expect(client.launched).toHaveLength(0);

    await backend.dispose();
  });
});

/**
 * Live variant: the issue's acceptance path is `POST /graph/runs` with the
 * resolved deployment document. This block boots the real Nest module over the
 * real Dagster gateway and drives that HTTP path to a real terminal. It skips
 * (never mocks) when no gateway was prepared.
 */
dagsterIntegrationDescribe(
  "Dagster etl_pipeline POST /graph/runs contract (SAA-1359 D5)",
  () => {
    jest.setTimeout(180_000);

    let app: INestApplication;
    let moduleRef: TestingModule;
    let backend: DagsterGraphExecutionBackend;

    beforeAll(async () => {
      backend = new DagsterGraphExecutionBackend();
      await backend.initialize({
        client: dagsterClient(),
        executionEnabled: true,
      });
      moduleRef = await Test.createTestingModule({
        imports: [
          TestRequestContextModule,
          GraphExecutionModule.forRoot({
            initAdapter: true,
            backend,
            runs: { auth: "optional", allowAnonymousAccess: true },
            workflows: { auth: "optional", allowAnonymousAccess: true },
          }),
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      try {
        await app?.close();
      } catch {
        // already closed
      }
      GraphExecutionBackendRegistry.clear();
    });

    it("accepts the resolved etl_pipeline document and reaches a real terminal", async () => {
      // The catalogue row resolves to the deployment document; the run request
      // carries that document inline, mirroring the list row's launch path.
      const document = await backend.getWorkflow("etl_pipeline");
      const created = await request(app.getHttpServer())
        .post("/graph/runs")
        .send({ workflow: document });

      expect(created.status).toBe(202);
      expect(created.body).toMatchObject({
        workflowId: "etl_pipeline",
        status: "queued",
      });
      const runId = created.body.runId as string;
      expect(runId).toBeTruthy();

      let run: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const fetched = await request(app.getHttpServer()).get(
          `/graph/runs/${runId}`
        );
        expect(fetched.status).toBe(200);
        run = fetched.body as Record<string, unknown>;
        if (
          run["status"] === "succeeded" ||
          run["status"] === "failed" ||
          run["status"] === "cancelled"
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      expect(run?.["workflowId"]).toBe("etl_pipeline");
      // The contract is the launch path: the real deployment run reaches a
      // terminal. The harness's etl_pipeline succeeds; record the terminal
      // verbatim if it ever legitimately fails instead of hiding it.
      expect(["succeeded", "failed", "cancelled"]).toContain(run?.["status"]);
      expect(run?.["status"]).toBe("succeeded");
    });
  }
);
