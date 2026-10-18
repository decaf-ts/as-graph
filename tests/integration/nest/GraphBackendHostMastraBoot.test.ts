/**
 * @module as-graph/tests/integration/nest/GraphBackendHostMastraBoot.test
 * @summary SAA-709 acceptance 3: boot `GraphExecutionModule.forRoot(host.moduleOptions)`
 * for the `mastra` variant and assert the per-engine workflow catalogue through
 * the real HTTP surface after a real execution.
 * @description Boots the host-assembled module with the real `@mastra/core`
 * backend wired through `createGraphBackendHost`, executes the existing
 * `tests/integration/mastra` two-leaf scenario through the module's
 * `GraphExecutionEngine`, and then reads the read-only `graph/engines` surface:
 * - `GET /graph/engines` advertises `defaultEngineId: "mastra"` and the mastra
 *   engine;
 * - `GET /graph/engines/mastra` serves the same descriptor; an unknown id 404s;
 * - `GET /graph/engines/mastra/workflows` lists the executed workflow, and
 *   applies the C23 ownership filter to a named foreign caller;
 * - `GET /graph/engines/mastra/workflows/:workflowId` serves the canonical
 *   document.
 */
import { jest, beforeAll, afterAll, it, expect } from "@jest/globals";

import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";

import { Context } from "@decaf-ts/core";
import { GraphNodeCatalogue } from "../../../src/engine/catalog/GraphNodeCatalogue";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { createTypeormGraphAdapter } from "../../../src/typeorm";
import type { TypeORMAdapter } from "@decaf-ts/for-typeorm";
import {
  resetGraphInjectables,
  resetGraphValueAdapter,
} from "../../unit/graph/engine-fixtures";
import {
  TEST_USER_HEADER,
  TestRequestContextModule,
} from "../../unit/nest/graphRunTestSupport";
import { integrationTwoLeafDocument, realStepHandler } from "../mastra/helpers";
import {
  closeLiveStores,
  liveAsGraphDataSourceOptions,
  liveCount,
  liveDescribe,
  liveMastra,
  purgeAsGraphWorkflows,
  purgeLiveRuns,
  sharedLiveStorage,
} from "../mastra/live-stack";

jest.setTimeout(60000);

const OBSERVABILITY_ENABLED_OVERRIDE = "MASTRA__OBSERVABILITY__ENABLED";
let observabilityEnabledOriginal: string | undefined;

beforeAll(() => {
  observabilityEnabledOriginal = process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  process.env[OBSERVABILITY_ENABLED_OVERRIDE] = "false";
});

afterAll(() => {
  if (observabilityEnabledOriginal === undefined) {
    delete process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  } else {
    process.env[OBSERVABILITY_ENABLED_OVERRIDE] = observabilityEnabledOriginal;
  }
});

/** Boots the mastra host-assembled module over the real Mastra runtime. */
async function bootMastraApp(): Promise<{
  app: INestApplication;
  moduleRef: TestingModule;
  adapter: TypeORMAdapter;
}> {
  resetGraphInjectables();
  resetGraphValueAdapter();
  const dataSourceOptions = liveAsGraphDataSourceOptions();
  if (!dataSourceOptions) {
    throw new Error("The live mastra stack is not configured");
  }
  const adapter = await createTypeormGraphAdapter({
    dataSource: dataSourceOptions,
  });
  const host = await createGraphBackendHost({
    variant: "mastra",
    base: {
      valueAdapter: adapter,
      runAdapter: adapter,
      runs: { auth: "optional", allowAnonymousAccess: true },
      workflows: { auth: "optional", allowAnonymousAccess: true },
      engines: { auth: "optional" },
    },
    mastra: {
      mastra: liveMastra("as-graph-it-nest-boot"),
      stepHandlers: [realStepHandler("test.leaf")],
    },
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      TestRequestContextModule,
      GraphExecutionModule.forRoot(host.moduleOptions),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, moduleRef, adapter };
}

liveDescribe("GraphBackendHost mastra boot (SAA-709 acceptance 3)", () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let adapter: TypeORMAdapter | undefined;

  beforeAll(async () => {
    await purgeAsGraphWorkflows(["mastra-it-two-leaf"]);
    await purgeLiveRuns(
      sharedLiveStorage(),
      ["mastra-host-run"],
      ["mastra-it-two-leaf"]
    );
    ({ app, moduleRef, adapter } = await bootMastraApp());
  });

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // already closed
    }
    await adapter?.shutdown();
    await purgeAsGraphWorkflows(["mastra-it-two-leaf"]);
    await purgeLiveRuns(
      sharedLiveStorage(),
      ["mastra-host-run"],
      ["mastra-it-two-leaf"]
    );
    await closeLiveStores();
  });

  const api = () => request(app.getHttpServer());

  it("1. GET /graph/engines serves the manifest with the mastra engine and defaultEngineId mastra", async () => {
    const res = await api().get("/graph/engines");
    expect(res.status).toBe(200);
    expect(res.body.defaultEngineId).toBe("mastra");
    const mastra = (res.body.engines as Array<Record<string, unknown>>).find(
      (engine) => engine.engineId === "mastra"
    );
    expect(mastra).toBeDefined();
    expect(mastra?.local).toBe(false);
  });

  it("2. GET /graph/engines/mastra serves the same descriptor; an unknown id 404s", async () => {
    const manifest = await api().get("/graph/engines");
    const expected = (
      manifest.body.engines as Array<Record<string, unknown>>
    ).find((engine) => engine.engineId === "mastra");

    const res = await api().get("/graph/engines/mastra");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expected);

    const unknown = await api().get("/graph/engines/does-not-exist");
    expect(unknown.status).toBe(404);
  });

  it("3. executes the mastra integration scenario through the module engine and lists it on the catalogue", async () => {
    // The module catalogue carries the built-in/demo kinds; register the
    // `tests/integration/mastra` leaf kind the existing scenario uses.
    moduleRef
      .get(GraphNodeCatalogue)
      .registerExecutor(
        "test.leaf",
        { execute: () => ({ out: {} }) },
        new Context()
      );
    const engine = moduleRef.get(GraphExecutionEngine);
    const document = integrationTwoLeafDocument();
    const result = await engine.execute(
      document,
      {},
      { runId: "mastra-host-run", auth: { user: "alice" } }
    );
    expect(result).toBeDefined();
    expect(
      await liveCount(
        sharedLiveStorage(),
        "select count(*)::int as count from mastra.mastra_workflow_snapshot where run_id = $1",
        ["mastra-host-run"]
      )
    ).toBe(1);

    const ownerList = await api()
      .get("/graph/engines/mastra/workflows")
      .set(TEST_USER_HEADER, "alice");
    expect(ownerList.status).toBe(200);
    expect(
      (ownerList.body as Array<{ workflowId: string }>).map(
        (row) => row.workflowId
      )
    ).toContain(document.id);

    const foreignList = await api()
      .get("/graph/engines/mastra/workflows")
      .set(TEST_USER_HEADER, "bob");
    expect(foreignList.status).toBe(200);
    expect(
      (foreignList.body as Array<{ workflowId: string }>).map(
        (row) => row.workflowId
      )
    ).not.toContain(document.id);

    const res = await api()
      .get(`/graph/engines/mastra/workflows/${document.id}`)
      .set(TEST_USER_HEADER, "alice");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(document.id);
    expect(res.body.name).toBe(document.name);
  });
});
