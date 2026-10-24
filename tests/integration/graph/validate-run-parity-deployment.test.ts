/**
 * @module as-graph/tests/integration/graph/validate-run-parity-deployment
 * @summary SAA-1386 D5 regression: deployment-projection validate/run parity.
 * @description Boots the real `GraphExecutionModule` over a Dagster-like
 * deployment backend (`local: false`, `documentValidation: "deployment"`) and
 * proves `POST /graph/workflows/validate` accepts exactly what the run path
 * accepts for an unknown-kind deployment document (SAA-1357 D2 parity,
 * deployment variant). The validate response never returns `resolved`.
 *
 * It also pins that the deployment leniency does not make the validate endpoint
 * permissive: a forbidden definition field is rejected by both paths with the
 * same structured issue code.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from "@jest/globals";
import { Context } from "@decaf-ts/core";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import {
  GraphExecutionEngine,
  GraphExecutionBackendRegistry,
} from "../../../src";
import { GraphDocumentValidationError } from "../../../src/engine/validation/GraphValidationErrors";
import { DagsterGraphExecutionBackend } from "../../../src/dagster/DagsterGraphExecutionBackend";
import type { DagsterJobRecord } from "../../../src/dagster/DagsterTypes";
import { GraphExecutionModule } from "../../../src/nest/graph";
import { documentNode } from "../../unit/graph/engine-fixtures";
import { FakeDagsterClient } from "../../unit/graph/dagster/dagster-fixtures";
import { TestRequestContextModule } from "../../unit/nest/graphRunTestSupport";

jest.setTimeout(120000);

const UNKNOWN_KIND = "deployment.projection.unknown";
const DEPLOYMENT_JOB = "deployment_job";

const JOB: DagsterJobRecord = {
  name: DEPLOYMENT_JOB,
  ops: [{ name: "op_a", nodeId: "op_a" }],
  dependencies: [],
};

/** An unknown-kind deployment document that maps onto the deployed job id. */
function unknownKindDocument(): GraphWorkflowDocument {
  return {
    id: DEPLOYMENT_JOB,
    name: DEPLOYMENT_JOB,
    inputs: [],
    outputs: [],
    nodes: [documentNode("op_a", UNKNOWN_KIND)],
    edges: [],
  };
}

/** Issue codes carried by a validation result body. */
function codesOf(body: { issues?: Array<{ code?: string }> }): string[] {
  return (body.issues ?? []).map((issue) => issue.code ?? "");
}

describe("deployment validate/run parity (SAA-1386 D5)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let engine: GraphExecutionEngine;
  let backend: DagsterGraphExecutionBackend;
  let client: FakeDagsterClient;

  beforeAll(async () => {
    client = new FakeDagsterClient(
      [
        { type: "STEP_START", stepKey: "op_a" },
        { type: "STEP_SUCCESS", stepKey: "op_a" },
      ],
      { runId: "launched-run", status: "success", outputs: {} },
      [{ name: DEPLOYMENT_JOB }],
      { [DEPLOYMENT_JOB]: JOB },
      { launchRunId: "launched-run" }
    );
    backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client, executionEnabled: true });

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
    engine = moduleRef.get(GraphExecutionEngine);
  });

  afterEach(() => {
    client.launched.length = 0;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      // already closed
    }
    GraphExecutionBackendRegistry.clear();
  });

  const validate = (document: GraphWorkflowDocument) =>
    request(app.getHttpServer())
      .post("/graph/workflows/validate")
      .send(document);

  it("wires the deployment backend into the engine", () => {
    expect(engine.backend).toBe(backend);
    expect(engine.backend.local).toBe(false);
    expect(engine.backend.documentValidation).toBe("deployment");
  });

  it("accepts the unknown-kind document on both the validate and run paths", async () => {
    const document = unknownKindDocument();

    const res = await validate(document);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ valid: true, issues: [] });
    expect(res.body).not.toHaveProperty("resolved");

    const result = await engine.execute(document, {}, new Context());
    expect(result.status).toBe("succeeded");
    expect(client.launched.map((launched) => launched.jobName)).toEqual([
      DEPLOYMENT_JOB,
    ]);
  });

  it("rejects a forbidden definition field on both paths with the same code", async () => {
    const document = unknownKindDocument();
    (document.nodes[0] as unknown as Record<string, unknown>)["executor"] = {};

    const res = await validate(document);
    expect(res.status).toBe(201);
    expect(res.body.valid).toBe(false);
    expect(res.body).not.toHaveProperty("resolved");
    expect(codesOf(res.body)).toContain("document.forbidden-field");

    let error: unknown;
    try {
      await engine.execute(document, {}, new Context());
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GraphDocumentValidationError);
    expect(
      (error as GraphDocumentValidationError).issues.map((issue) => issue.code)
    ).toContain("document.forbidden-field");
    expect(client.launched).toHaveLength(0);
  });
});
