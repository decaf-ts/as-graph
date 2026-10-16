/**
 * @module as-graph/tests/e2e/graph/fixtures
 * @summary SAA-2049 e2e evidence: the persisted demo workflow fixtures run
 * end to end through the public `GraphExecutionEngine.execute` entrypoint, plus
 * SAA-721 fixture→catalog parity: the host-assembled module (`createGraphBackendHost`
 * + `GraphExecutionModule.forRoot`) serves the full fixture registry through the
 * per-engine catalogue and the ownership-filtered serving list for every engine
 * driver (local/mastra/dagster), and the run detail endpoints expose each node's
 * intermediate inputs/outputs untruncated.
 * @description Boots the real engine and drives a representative fixture for
 * every executable kind family — triggers, branching, loops, utilities and the
 * `value`/`result` boundaries — asserting the workflow output. The parity lane
 * boots the real Nest host over the real HTTP surface for each engine variant,
 * deriving the expected set from `graphWorkflowFixtures` (never hard-coding ids).
 */
import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";

import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";
import {
  createGraphBackendHost,
  type GraphEngineVariant,
} from "../../../src/nest/graph/GraphBackendHost";
import {
  resetGraphAdapters,
  resetGraphInjectables,
  resetGraphValueAdapter,
} from "../../unit/graph/engine-fixtures";
import { TestRequestContextModule } from "../../unit/nest/graphRunTestSupport";
import { realStepHandler } from "../../integration/mastra/helpers";
import { runFixtureDocument } from "../../fixtures/workflow-engine";
import {
  executableWorkflowFixtures,
  graphWorkflowFixtures,
} from "../../../src/workflows";

jest.setTimeout(180000);

describe("demo workflow fixtures — end to end (SAA-2049)", () => {
  it("executes the full executable fixture set through GraphExecutionEngine.execute", async () => {
    for (const fixture of executableWorkflowFixtures) {
      const result = await runFixtureDocument(
        fixture.document,
        fixture.inputs ?? {}
      );
      expect({ id: fixture.id, status: result.status }).toEqual({
        id: fixture.id,
        status: "succeeded",
      });
      for (const [key, value] of Object.entries(
        fixture.expectedOutputs ?? {}
      )) {
        expect({
          id: fixture.id,
          output: key,
          value: (result.outputs as Record<string, unknown>)[key],
        }).toEqual({ id: fixture.id, output: key, value });
      }
    }
  }, 180000);

  it("drives the boundary value/result workflow end to end", async () => {
    const fixture = graphWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-boundary-value"
    )!;
    const result = await runFixtureDocument(fixture.document, fixture.inputs ?? {});
    expect(result.status).toBe("succeeded");
    expect(result.outputs.out).toBeNull();
    expect(result.nodeResults.seed.outputs).toEqual({ value: null });
    expect(result.nodeResults.sink.status).toBe("succeeded");
  });

  it("drives the if→switch workflow down the then/high branch end to end", async () => {
    const fixture = graphWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-if-switch"
    )!;
    const result = await runFixtureDocument(fixture.document, { n: 7 });
    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe(70);
  });
});

/**
 * The expected fixture id set, derived from the fixture registry export — never
 * hard-coded — so a registry change flows straight into the parity assertions.
 */
const FIXTURE_DOCUMENTS = graphWorkflowFixtures.map(
  (fixture) => fixture.document
);
const FIXTURE_IDS = FIXTURE_DOCUMENTS.map((document) => document.id).sort();

/** The seeded fixture documents forwarded to the host on boot. */
function seedDocuments() {
  return graphWorkflowFixtures.map((fixture) => fixture.document);
}

/** Maps a serving list body to its sorted workflow id set. */
function servedIds(rows: Array<{ workflowId: string }>): string[] {
  return rows.map((row) => row.workflowId).sort();
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Boots the real host-assembled Nest module for one engine variant with the
 * full fixture registry seeded at boot, over the header-driven request context.
 */
async function bootHostApp(
  variant: GraphEngineVariant
): Promise<INestApplication> {
  resetGraphInjectables();
  resetGraphValueAdapter();
  resetGraphAdapters();
  GraphExecutionBackendRegistry.clear();
  const host = await createGraphBackendHost({
    variant,
    seedWorkflows: seedDocuments(),
    base: {
      initAdapter: true,
      runs: { auth: "optional", allowAnonymousAccess: true },
      workflows: { auth: "optional", allowAnonymousAccess: true },
      engines: { auth: "optional" },
    },
    ...(variant === "mastra"
      ? { mastra: { mastra: {}, stepHandlers: [realStepHandler("test.leaf")] } }
      : {}),
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      TestRequestContextModule,
      GraphExecutionModule.forRoot(host.moduleOptions),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

/** Polls `GET /graph/runs/:runId` until the run reaches a terminal state. */
async function waitForTerminalRun(
  api: () => request.SuperTest<request.Test>,
  runId: string,
  timeoutMs = 120000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api().get(`/graph/runs/${runId}`);
    if (
      res.status === 200 &&
      ["succeeded", "failed", "cancelled"].includes(
        String((res.body as { status?: unknown }).status)
      )
    ) {
      return res.body as Record<string, unknown>;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Run '${runId}' did not reach a terminal state within ${timeoutMs}ms; last ${res.status} ${JSON.stringify(
          res.body
        ).slice(0, 200)}`
      );
    }
    await delay(50);
  }
}

describe.each([
  ["local", "local"],
  ["mastra", "mastra"],
  ["dagster", "dagster"],
] as Array<[GraphEngineVariant, string]>)(
  "fixture→catalog parity — %s (SAA-721)",
  (variant, engineId) => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootHostApp(variant);
    });

    afterAll(async () => {
      try {
        await app.close();
      } catch {
        // already closed
      }
    });

    const api = () => request(app.getHttpServer());

    it("1. GET /graph/engines/:engineId/workflows lists exactly the fixture set", async () => {
      const res = await api().get(`/graph/engines/${engineId}/workflows`);
      expect(res.status).toBe(200);
      expect(servedIds(res.body as Array<{ workflowId: string }>)).toEqual(
        FIXTURE_IDS
      );
    });

    it("2. GET /graph/workflows lists exactly the fixture set", async () => {
      const res = await api().get("/graph/workflows");
      expect(res.status).toBe(200);
      expect(servedIds(res.body as Array<{ workflowId: string }>)).toEqual(
        FIXTURE_IDS
      );
    });

    it("3. GET /graph/engines/:engineId/workflows/:workflowId serves each seeded document", async () => {
      for (const document of FIXTURE_DOCUMENTS) {
        const res = await api()
          .get(`/graph/engines/${engineId}/workflows/${document.id}`)
          .set("x-test-user", "parity-caller");
        expect({ id: document.id, status: res.status }).toEqual({
          id: document.id,
          status: 200,
        });
        expect(res.body).toEqual(document);
      }
    });
  }
);

describe("dagster fixture catalogue is read-only (SAA-721)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootHostApp("dagster");
  });

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // already closed
    }
  });

  const api = () => request(app.getHttpServer());

  it("lists + serves the fixtures while the manifest declares no authoring capability", async () => {
    const list = await api().get("/graph/engines/dagster/workflows");
    expect(list.status).toBe(200);
    expect(servedIds(list.body as Array<{ workflowId: string }>)).toEqual(
      FIXTURE_IDS
    );

    const descriptor = await api().get("/graph/engines/dagster");
    expect(descriptor.status).toBe(200);
    const capabilities = (
      descriptor.body as {
        capabilities: Array<{ feature: string; verdict: string }>;
      }
    ).capabilities;
    const listing = capabilities.find(
      (row) => row.feature === "list / inspect existing workflows"
    );
    expect(listing?.verdict).toBe("SUPPORTED");
    const authoring = capabilities.filter(
      (row) =>
        row.feature !== "list / inspect existing workflows" &&
        row.feature !== "execute existing workflow (launch run)" &&
        row.feature !== "replay / re-execute existing run"
    );
    expect(authoring.length).toBeGreaterThan(0);
    for (const row of authoring) expect(row.verdict).toBe("NOT_SUPPORTED");
  });

  it("exposes no create/update path through the engine catalogue", async () => {
    const created = await api()
      .post("/graph/engines/dagster/workflows")
      .send({});
    expect([404, 405]).toContain(created.status);
    const updated = await api()
      .put("/graph/engines/dagster/workflows/fixture-manual-log")
      .send({});
    expect([404, 405]).toContain(updated.status);
  });
});

describe("run detail serves per-node I/O untruncated (SAA-721)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootHostApp("local");
  });

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // already closed
    }
  });

  const api = () => request(app.getHttpServer());

  it("GET /graph/runs/:runId and the workflow run history expose nodeResults verbatim", async () => {
    const fixture = graphWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-manual-log"
    )!;

    const created = await api()
      .post("/graph/runs")
      .send({ workflowId: fixture.id, inputs: fixture.inputs ?? {} });
    expect(created.status).toBe(202);
    const runId = (created.body as { runId: string }).runId;

    const run = await waitForTerminalRun(api, runId);
    expect(run.status).toBe("succeeded");
    const nodeResults = (
      run.result as {
        nodeResults: Record<
          string,
          { inputs: unknown; outputs?: unknown }
        >;
      }
    ).nodeResults;

    // Exactly the intermediate I/O recorded by execution — no truncation.
    expect(nodeResults.trigger.outputs).toEqual({ payload: null });
    expect(nodeResults.logger.inputs).toEqual({ value: null });
    expect(nodeResults.logger.outputs).toEqual({ value: null });
    expect(nodeResults.audit.inputs).toEqual({ value: null });

    // The workflow run-history endpoint serves the same untruncated node I/O.
    const history = await api().get(`/graph/workflows/${fixture.id}/runs`);
    expect(history.status).toBe(200);
    const row = (history.body as Array<Record<string, unknown>>).find(
      (candidate) => candidate.runId === runId
    );
    expect(row).toBeDefined();
    expect(
      (row!.result as { nodeResults: unknown }).nodeResults
    ).toEqual(nodeResults);
  }, 180000);
});
