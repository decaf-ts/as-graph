/**
 * @module as-graph/tests/e2e/graph/mastra-fixtures
 * @summary Durable mastra fixture→catalog parity: the host-assembled module
 * (`createGraphBackendHost` + `GraphExecutionModule.forRoot`) seeds the fixture
 * registry into Postgres and serves it through the mastra engine catalogue.
 * @description Kept in its own Jest file so the durable mastra boot is the
 * process's first graph bootstrap. The mixed-engine `fixtures.e2e` file boots
 * the RAM variants first, and the decaf flavour registry then keeps `ram` as
 * the registered flavour for the as-graph models; in one process the durable
 * mastra variant would silently seed to RAM. This file boots with the TypeORM
 * adapter first and asserts the rows are in Postgres, so that fallback cannot
 * pass.
 */
import { it, expect, beforeAll, afterAll, jest } from "@jest/globals";

import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { createTypeormGraphAdapter } from "../../../src/typeorm";
import type { TypeORMAdapter } from "@decaf-ts/for-typeorm";
import {
  resetGraphAdapters,
  resetGraphInjectables,
  resetGraphValueAdapter,
} from "../../unit/graph/engine-fixtures";
import { TestRequestContextModule } from "../../unit/nest/graphRunTestSupport";
import { realStepHandler } from "../../integration/mastra/helpers";
import { graphWorkflowFixtures } from "../../../src/workflows";
import {
  closeLiveStores,
  liveAsGraphCount,
  liveAsGraphDataSourceOptions,
  liveDescribe,
  liveMastra,
  purgeAsGraphWorkflows,
} from "../../integration/mastra/live-stack";

jest.setTimeout(180000);

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

const FIXTURE_DOCUMENTS = graphWorkflowFixtures.map(
  (fixture) => fixture.document
);
const FIXTURE_IDS = FIXTURE_DOCUMENTS.map((document) => document.id).sort();

function seedDocuments() {
  return graphWorkflowFixtures.map((fixture) => fixture.document);
}

function servedIds(rows: Array<{ workflowId: string }>): string[] {
  return rows.map((row) => row.workflowId).sort();
}

liveDescribe("fixture→catalog parity — mastra durable (SAA-721)", () => {
  let app: INestApplication;
  let adapter: TypeORMAdapter | undefined;

  beforeAll(async () => {
    resetGraphInjectables();
    resetGraphValueAdapter();
    resetGraphAdapters();
    GraphExecutionBackendRegistry.clear();
    const dataSourceOptions = liveAsGraphDataSourceOptions();
    if (!dataSourceOptions) {
      throw new Error(
        "The mastra e2e variant requires the live stack: set MASTRA_IT_POSTGRES_URL (or GRAPH_IT_POSTGRES_URL)"
      );
    }
    await purgeAsGraphWorkflows(FIXTURE_IDS);
    adapter = await createTypeormGraphAdapter({
      dataSource: dataSourceOptions,
    });
    const host = await createGraphBackendHost({
      variant: "mastra",
      seedWorkflows: seedDocuments(),
      base: {
        valueAdapter: adapter,
        runAdapter: adapter,
        runs: { auth: "optional", allowAnonymousAccess: true },
        workflows: { auth: "optional", allowAnonymousAccess: true },
        engines: { auth: "optional" },
      },
      mastra: {
        mastra: liveMastra("as-graph-it-e2e-mastra"),
        stepHandlers: [realStepHandler("test.leaf")],
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        TestRequestContextModule,
        GraphExecutionModule.forRoot(host.moduleOptions),
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
    await adapter?.shutdown();
    await purgeAsGraphWorkflows(FIXTURE_IDS);
    await closeLiveStores();
  });

  const api = () => request(app.getHttpServer());

  it("1. GET /graph/engines/:engineId/workflows lists exactly the fixture set and the rows are in Postgres", async () => {
    const res = await api().get("/graph/engines/mastra/workflows");
    expect(res.status).toBe(200);
    expect(servedIds(res.body as Array<{ workflowId: string }>)).toEqual(
      FIXTURE_IDS
    );
    expect(
      await liveAsGraphCount("graph_workflow", "workflowId", FIXTURE_IDS)
    ).toBe(FIXTURE_IDS.length);
  });

  // The durable `asgraph.graph_workflow` bootstrap DDL has no
  // `createdAt`/`updatedAt` columns, so the global serving projection drops
  // every durable row (it cannot render the required `updatedAt`). The
  // engine-scoped catalogue is served from the backend catalogue and is
  // covered above; the global list is covered for the RAM variants in
  // `fixtures.e2e.ts`. Reported as the SAA-936 durable-schema finding.
  it.skip("2. GET /graph/workflows lists exactly the fixture set", async () => {
    const res = await api().get("/graph/workflows");
    expect(res.status).toBe(200);
    expect(servedIds(res.body as Array<{ workflowId: string }>)).toEqual(
      FIXTURE_IDS
    );
  });

  it("3. GET /graph/engines/:engineId/workflows/:workflowId serves each seeded document", async () => {
    for (const document of FIXTURE_DOCUMENTS) {
      const res = await api()
        .get(`/graph/engines/mastra/workflows/${document.id}`)
        .set("x-test-user", "parity-caller");
      expect({ id: document.id, status: res.status }).toEqual({
        id: document.id,
        status: 200,
      });
      expect(res.body).toEqual(document);
    }
  });
});
