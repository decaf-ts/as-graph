/**
 * @module as-graph/tests/integration/mastra/MastraMetricsReads
 * @summary SAA-836 S2 integration evidence: the read-only mastra metrics
 * adapter/statement/paginator/gateway and the editor-endpoint delegation over
 * the real `@mastra/core` storage.
 * @description Real-vs-injected note. **Real**: a real `Mastra` instance backed
 * by a real `InMemoryStore` (mirroring the existing suite helpers), the real
 * storage domains (`workflows`/`scores`/`observability`) written through their
 * production APIs (`persistWorkflowSnapshot`, `saveScore`, `batchCreateSpans`),
 * the production `MastraGraphExecutionBackend` (with a real two-leaf run
 * executed through `backend.execute` to register an owner-scoped catalogue
 * entry), and the production delegation/gateway/adapter stack.
 * **Host-injected**: only the frame-bound event sink for the backend run (the
 * engine normally creates it), matching the existing Mastra integration suite.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "@jest/globals";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { NotFoundError } from "@decaf-ts/db-decorators";
import { PagingError } from "@decaf-ts/core";
import { MastraMetricsAdapter } from "../../../src/mastra/MastraMetricsAdapter";
import {
  MastraMetricsGateway,
  type MastraMetricsOwnership,
} from "../../../src/mastra/MastraMetricsGateway";
import { MastraMetricsStatement } from "../../../src/mastra/MastraMetricsStatement";
import {
  mastraRunMetricsDelegationOf,
  type MastraRunMetricsPageHttp,
} from "../../../src/mastra/MastraRunMetricsEndpoint";
import {
  MastraRunMetricModel,
  MastraScoreMetricModel,
  MastraTraceMetricModel,
} from "../../../src/mastra/MastraMetricsModels";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { document, edge, node } from "../../../src/workflows/builders";
import {
  integrationTwoLeafDocument,
  realStepHandler,
  userContext,
} from "./helpers";

const NODE_KIND = "test.leaf";
const WORKFLOW_ID = "mastra-it-metrics-wf";

// SAA-891: the mastra engine's observability lane (SAA-836 O1) fails closed
// without langfuse credentials, and this suite boots real runtimes through
// `MastraGraphExecutionBackend.initialize`. The metrics reads under test are
// independent of observability, so the lane is disabled for the suite (the
// credential gate itself is covered by the MastraObservability tests) and the
// override is restored afterwards.
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

/** True ISO-8601 rendering the served rows must carry. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** A real `Mastra` runtime backed by a real `InMemoryStore`. */
function realRuntime(): Mastra {
  return new Mastra({ storage: new InMemoryStore() });
}

/** The workflow run rows the real InMemoryStore serves for the fixture workflow. */
function runRows(): Array<{ runId: string }> {
  return Array.from({ length: 5 }, (_, index) => ({ runId: `run-${index + 1}` }));
}

/** Seeds N real workflow runs through the real `workflows` storage domain. */
async function seedRuns(runtime: Mastra): Promise<void> {
  const workflows = (await runtime.getStorage().getStore("workflows")) as {
    persistWorkflowSnapshot: (args: {
      workflowName: string;
      runId: string;
      snapshot: unknown;
    }) => Promise<unknown>;
  };
  for (const row of runRows()) {
    await workflows.persistWorkflowSnapshot({
      workflowName: WORKFLOW_ID,
      runId: row.runId,
      snapshot: {
        status: index0Success(row.runId),
        steps: {},
        context: {},
      },
    });
  }
}

function index0Success(runId: string): string {
  return runId === "run-1" ? "success" : "running";
}

/** Seeds one real score record for run-1 through the real `scores` domain. */
async function seedScore(runtime: Mastra): Promise<void> {
  const scores = (await runtime.getStorage().getStore("scores")) as {
    saveScore: (payload: Record<string, unknown>) => Promise<unknown>;
  };
  await scores.saveScore({
    scoreId: "score-1",
    scorerId: "integration-scorer",
    entityType: "WORKFLOW",
    entityId: "run-1",
    runId: "run-1",
    timestamp: new Date(),
    input: { prompt: "hello" },
    output: { reason: "all good" },
    score: 0.75,
  });
}

/** Seeds one real span for run-1 through the real `observability` domain. */
async function seedSpan(runtime: Mastra): Promise<void> {
  const observability = (await runtime.getStorage().getStore("observability")) as {
    batchCreateSpans: (args: { records: Record<string, unknown>[] }) => Promise<unknown>;
  };
  await observability.batchCreateSpans({
    records: [
      {
        traceId: "trace-1",
        spanId: "span-1",
        runId: "run-1",
        name: "root span",
        spanType: "workflow",
        scope: {},
        status: "success",
        attributes: { step: "first" },
        startedAt: new Date(),
        endedAt: new Date(),
      },
    ],
  });
}

/** The gateway ownership anchor matching the fixture catalogue. */
function fixtureOwnership(
  owned: Record<string, string | undefined>
): MastraMetricsOwnership {
  return {
    resolveWorkflow: (workflowId) =>
      workflowId in owned ? { known: true, ...(owned[workflowId] ? { owner: owned[workflowId] } : {}) } : undefined,
  };
}

describe("Mastra metrics reads over the real mastra storage (SAA-836 S2)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("projects real run rows through the read-only adapter", async () => {
    const runtime = realRuntime();
    await seedRuns(runtime);
    const adapter = new MastraMetricsAdapter(
      { mastra: runtime },
      `mastra-metrics-it-runs-${Date.now()}`
    );

    const rows = await adapter.raw<MastraRunMetricModel[], true>(
      { kind: "runs", workflowName: WORKFLOW_ID },
      true
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row).toBeInstanceOf(MastraRunMetricModel);
      expect(row.workflowId).toBe(WORKFLOW_ID);
      expect(row.status === "success" || row.status === "running").toBe(true);
      expect(row.createdAt).toBeInstanceOf(Date);
    }
    expect(rows[0].snapshot).toEqual({
      status: index0Success("run-1"),
      steps: {},
      context: {},
    });
  });

  it("projects real score and trace rows through the read-only adapter", async () => {
    const runtime = realRuntime();
    await seedRuns(runtime);
    await seedScore(runtime);
    await seedSpan(runtime);
    const adapter = new MastraMetricsAdapter(
      { mastra: runtime },
      `mastra-metrics-it-scores-${Date.now()}`
    );

    // The real scores domain assigns its own storage id; read it back first.
    const scoresStore = (await runtime.getStorage().getStore("scores")) as {
      listScoresByRunId: (input: {
        runId: string;
        pagination: { page: number; perPage: false };
      }) => Promise<{ scores: Array<{ id: string; scoreId: string }> }>;
    };
    const stored = (await scoresStore.listScoresByRunId({
      runId: "run-1",
      pagination: { page: 0, perPage: false },
    })).scores[0];
    expect(stored.id).toBeDefined();

    const scores = await adapter.raw<MastraScoreMetricModel[], true>(
      { kind: "scores", workflowName: WORKFLOW_ID, runId: "run-1" },
      true
    );
    expect(scores).toHaveLength(1);
    expect(scores[0]).toBeInstanceOf(MastraScoreMetricModel);
    expect(scores[0].scoreId).toBe(stored.id);
    expect(scores[0].scorerId).toBe("integration-scorer");
    expect(scores[0].score).toBe(0.75);
    expect(scores[0].input).toEqual({ prompt: "hello" });
    expect(scores[0].output).toEqual({ reason: "all good" });
    expect(scores[0].workflowId).toBe(WORKFLOW_ID);

    const spans = await adapter.raw<MastraTraceMetricModel[], true>(
      { kind: "traces", workflowName: WORKFLOW_ID, runId: "run-1" },
      true
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toBeInstanceOf(MastraTraceMetricModel);
    expect(spans[0].spanId).toBe("span-1");
    expect(spans[0].traceId).toBe("trace-1");
    expect(spans[0].status).toBe("success");
    expect(spans[0].summary).toEqual({ attributes: { step: "first" } });
  });

  it("pages real run rows through the statement/paginator with mastra-native mapping", async () => {
    const runtime = realRuntime();
    await seedRuns(runtime);
    const adapter = new MastraMetricsAdapter(
      { mastra: runtime },
      `mastra-metrics-it-paging-${Date.now()}`
    );
    const statement = new MastraMetricsStatement(adapter)
      .forWorkflow(WORKFLOW_ID)
      .from(MastraRunMetricModel);
    const paginator = await statement.paginate(2);

    const page2 = await paginator.page(2);
    expect(page2.map((row) => row.runId)).toEqual(["run-3", "run-4"]);
    expect(paginator.current).toBe(2);
    expect(paginator.count).toBe(5);
    expect(paginator.total).toBe(3);

    await expect(paginator.page(4)).rejects.toBeInstanceOf(PagingError);
  });

  it("serves the workflow's runs through the owner-scoped gateway", async () => {
    const runtime = realRuntime();
    await seedRuns(runtime);
    const gateway = new MastraMetricsGateway({
      mastra: runtime,
      ownership: fixtureOwnership({ [WORKFLOW_ID]: undefined }),
      alias: `mastra-metrics-it-gateway-${Date.now()}`,
    });

    const page = await gateway.listRuns(WORKFLOW_ID, "anyone", 2, 2);
    expect(page.data).toHaveLength(2);
    expect(page.current).toBe(2);
    expect(page.count).toBe(5);
    expect(page.total).toBe(3);

    await expect(gateway.listRuns("wf-unknown", "anyone")).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it("delegates the editor runs endpoint through the real backend catalogue", async () => {
    const runtime = realRuntime();
    await seedRuns(runtime);
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: runtime,
      stepHandlers: [realStepHandler(NODE_KIND)],
    });

    // Owner-less (seeded) mastra-owned workflow: the delegation serves it.
    await backend.seedWorkflows([
      document({
        id: WORKFLOW_ID,
        name: WORKFLOW_ID,
        nodes: [node("first", NODE_KIND), node("second", NODE_KIND)],
        edges: [edge("e1", ["node", "first", "out"], ["node", "second", "in"])],
      }),
    ]);
    const delegation = mastraRunMetricsDelegationOf(backend);
    expect(delegation).toBeDefined();

    const flat = (await delegation!.listRuns(
      WORKFLOW_ID,
      "anyone",
      undefined,
      undefined
    )) as Record<string, unknown>[];
    expect(Array.isArray(flat)).toBe(true);
    expect(flat.map((row) => row.runId)).toEqual([
      "run-1",
      "run-2",
      "run-3",
      "run-4",
      "run-5",
    ]);
    for (const row of flat) {
      expect(row.workflowId).toBe(WORKFLOW_ID);
      expect(row.createdAt).toMatch(ISO_8601);
    }

    const paged = (await delegation!.listRuns(
      WORKFLOW_ID,
      "anyone",
      2,
      2
    )) as MastraRunMetricsPageHttp;
    expect(Object.keys(paged).sort()).toEqual(["count", "current", "data", "total"]);
    expect(paged.current).toBe(2);
    expect(paged.total).toBe(3);
    expect(paged.count).toBe(5);
    expect(paged.data.map((row) => row.runId)).toEqual(["run-3", "run-4"]);

    // A workflow outside the mastra catalogue falls back to the local rows.
    await expect(
      delegation!.listRuns("not-mastra-owned", "anyone", undefined, undefined)
    ).resolves.toBeUndefined();
  });

  it("denies a foreign owner for an owner-scoped backend workflow (C23)", async () => {
    const runtime = realRuntime();
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: runtime,
      stepHandlers: [realStepHandler(NODE_KIND)],
    });

    const source = integrationTwoLeafDocument();
    await backend.execute(
      {
        document: source,
        plan: {} as never,
        inputs: { in: 1 },
        options: {} as never,
        events: (await import("./helpers")).frameSinkHarness(
          "mastra-it-metrics-owned-run"
        ).sink,
      },
      userContext("alice")
    );

    const delegation = mastraRunMetricsDelegationOf(backend);
    await expect(
      delegation!.listRuns(source.id, "bob", undefined, undefined)
    ).rejects.toBeInstanceOf(NotFoundError);
    // SAA-891: under the O1 runtime binding the real mastra run persists its
    // run snapshot into the InMemoryStore, so the owner's list now serves the
    // real run row (owner-scoped); the foreign owner stays denied above.
    const rows = (await delegation!.listRuns(
      source.id,
      "alice",
      undefined,
      undefined
    )) as Record<string, unknown>[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe("mastra-it-metrics-owned-run");
    expect(rows[0].workflowId).toBe(source.id);
    expect(rows[0].owner).toBe("alice");
    expect(rows[0].status).toBe("success");
    expect(rows[0].createdAt).toMatch(ISO_8601);
  });
});
