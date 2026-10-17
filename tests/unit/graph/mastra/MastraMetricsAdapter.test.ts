/**
 * @module as-graph/tests/unit/graph/mastra/MastraMetricsAdapter
 * @summary Unit evidence for the read-only mastra metrics adapter (SAA-836 S2).
 * @description Proves the adapter seam contract over a structural fake of the
 * `@mastra/core` storage composite store: writes fail closed
 * (`GRAPH_MASTRA_METRICS_READ_ONLY`), missing storage/domain fail closed
 * (`GRAPH_MASTRA_METRICS_UNAVAILABLE`), every read delegates to the real
 * mastra storage domain contracts (argument shapes pinned), JSON-safe rows are
 * projected, and unprojectable rows are skipped (R7, never fabricated).
 */
import {
  MastraMetricsAdapter,
  MASTRA_METRICS_FLAVOUR,
  type MastraMetricsCompositeStoreLike,
  type MastraMetricsQuery,
  type MastraMetricsObservabilityStoreLike,
  type MastraMetricsScoresStoreLike,
  type MastraMetricsWorkflowsStoreLike,
} from "../../../../src/mastra/MastraMetricsAdapter";
import {
  MastraRunMetricModel,
  MastraScoreMetricModel,
  MastraTraceMetricModel,
  type MastraStorageRunRow,
  type MastraStorageScoreRow,
  type MastraStorageSpanRow,
} from "../../../../src/mastra/MastraMetricsModels";
import {
  GRAPH_MASTRA_METRICS_READ_ONLY,
  GRAPH_MASTRA_METRICS_UNAVAILABLE,
} from "../../../../src/mastra/types";
import { NotFoundError } from "@decaf-ts/db-decorators";
import { UnsupportedError } from "@decaf-ts/core";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";

/** The workflow rows a fake mastra storage serves. */
function runRows(): MastraStorageRunRow[] {
  return [
    {
      runId: "run-1",
      workflowName: "wf-a",
      resourceId: "res-1",
      snapshot: { status: "success", steps: {} },
      createdAt: new Date("2026-01-01T10:00:00Z"),
      updatedAt: new Date("2026-01-01T10:01:00Z"),
    },
    {
      runId: "run-2",
      workflowName: "wf-a",
      snapshot: JSON.stringify({ status: "running" }),
      createdAt: new Date("2026-01-01T10:02:00Z"),
    },
    // Unprojectable: no run id — the adapter must skip it, never fabricate.
    {
      workflowName: "wf-a",
      snapshot: { status: "success" },
      createdAt: new Date("2026-01-01T10:03:00Z"),
    } as unknown as MastraStorageRunRow,
  ];
}

/** A fake mastra runtime exposing the given storage domains. */
function fakeMastra(
  domains: Record<string, unknown>
): { mastra: unknown } & { storage: MastraMetricsCompositeStoreLike } {
  const storage: MastraMetricsCompositeStoreLike = {
    getStore: (domain: string) => Promise.resolve(domains[domain]),
  };
  return {
    mastra: { getStorage: () => storage },
    storage,
  };
}

/**
 * Builds the adapter with a unique alias: the Decaf adapter registry rejects
 * duplicate flavour aliases, and the production wiring guarantees a unique
 * alias per gateway (`mastra-metrics-<n>`), so the tests do the same.
 */
let ADAPTER_SEQUENCE = 0;
function metricsAdapter(
  config: { mastra: unknown }
): MastraMetricsAdapter {
  return new MastraMetricsAdapter(config, `mastra-metrics-test-${++ADAPTER_SEQUENCE}`);
}

/** A fake workflows domain recording every list/lookup call. */
function fakeWorkflowsStore(
  rows: MastraStorageRunRow[],
  byId: Record<string, MastraStorageRunRow | null> = {}
): { store: MastraMetricsWorkflowsStoreLike; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    store: {
      listWorkflowRuns: async (args) => {
        calls.push(args);
        return { runs: rows, total: rows.length };
      },
      getWorkflowRunById: async (args) => {
        calls.push(args);
        return byId[String(args.runId)] ?? null;
      },
    },
  };
}

describe("MastraMetricsAdapter (SAA-836 S2)", () => {
  it("registers under the dedicated read-only metrics flavour", () => {
    const adapter = metricsAdapter(fakeMastra({}).mastra);
    expect(adapter.flavour).toBe(MASTRA_METRICS_FLAVOUR);
  });

  describe("fail-closed writes", () => {
    it("rejects create/update/delete with the read-only code", async () => {
      const adapter = metricsAdapter(fakeMastra({}).mastra);
      for (const op of [
        () => adapter.create(),
        () => adapter.update(),
        () => adapter.delete(),
      ]) {
        await expect(op()).rejects.toBeInstanceOf(UnsupportedError);
        await expect(op()).rejects.toThrow(GRAPH_MASTRA_METRICS_READ_ONLY);
      }
    });
  });

  describe("fail-closed availability", () => {
    it("fails closed when the runtime exposes no storage", async () => {
      const adapter = metricsAdapter({ mastra: {} });
      await expect(
        adapter.raw({ kind: "runs", workflowName: "wf-a" }, true)
      ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_METRICS_UNAVAILABLE });
    });

    it("fails closed when the runtime exposes no getStorage at all", async () => {
      const adapter = metricsAdapter({ mastra: undefined });
      await expect(
        adapter.raw({ kind: "runs", workflowName: "wf-a" }, true)
      ).rejects.toBeInstanceOf(GraphExecutionError);
    });

    it("fails closed when a queried domain is absent from the storage", async () => {
      const { mastra } = fakeMastra({ workflows: undefined });
      const adapter = metricsAdapter({ mastra });
      await expect(
        adapter.raw({ kind: "runs", workflowName: "wf-a" }, true)
      ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_METRICS_UNAVAILABLE });

      const scoresMissing = fakeMastra({});
      const scoresAdapter = metricsAdapter({ mastra: scoresMissing.mastra });
      await expect(
        scoresAdapter.raw(
          { kind: "scores", workflowName: "wf-a", runId: "run-1" },
          true
        )
      ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_METRICS_UNAVAILABLE });

      const obsMissing = fakeMastra({});
      const obsAdapter = metricsAdapter({ mastra: obsMissing.mastra });
      await expect(
        obsAdapter.raw(
          { kind: "traces", workflowName: "wf-a", runId: "run-1" },
          true
        )
      ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_METRICS_UNAVAILABLE });
    });
  });

  describe("raw runs reads", () => {
    it("projects JSON-safe rows and skips unprojectable ones (R7)", async () => {
      const workflows = fakeWorkflowsStore(runRows());
      const runtime = fakeMastra({ workflows: workflows.store });
      const adapter = metricsAdapter({ mastra: runtime.mastra });

      const docsOnly = await adapter.raw<MastraRunMetricModel[], true>(
        { kind: "runs", workflowName: "wf-a" },
        true
      );
      expect(docsOnly).toHaveLength(2);
      expect(docsOnly[0]).toBeInstanceOf(MastraRunMetricModel);
      expect(docsOnly.map((row) => row.runId)).toEqual(["run-1", "run-2"]);

      const enveloped = await adapter.raw<MastraRunMetricModel[], false>(
        { kind: "runs", workflowName: "wf-a" },
        false
      );
      expect(enveloped.count).toBe(3);
      expect(enveloped.data).toHaveLength(2);
      expect(enveloped.data.map((row) => row.status)).toEqual([
        "success",
        "running",
      ]);
    });

    it("scopes the mastra read to the canonical workflow name", async () => {
      const workflows = fakeWorkflowsStore([]);
      const runtime = fakeMastra({ workflows: workflows.store });
      const adapter = metricsAdapter({ mastra: runtime.mastra });
      await adapter.raw({ kind: "runs", workflowName: "wf-a" }, true);
      expect(workflows.calls[0]).toEqual({ workflowName: "wf-a", perPage: false });
    });

    it("narrows runs by the requested status after projection", async () => {
      const workflows = fakeWorkflowsStore(runRows());
      const runtime = fakeMastra({ workflows: workflows.store });
      const adapter = metricsAdapter({ mastra: runtime.mastra });
      const rows = await adapter.raw<MastraRunMetricModel[], true>(
        { kind: "runs", workflowName: "wf-a", status: "success" },
        true
      );
      expect(rows.map((row) => row.runId)).toEqual(["run-1"]);
    });

    it("falls back to the queried workflow name when a row carries none", async () => {
      const rows: MastraStorageRunRow[] = [
        {
          runId: "run-1",
          snapshot: { status: "success" },
          createdAt: new Date(),
        },
      ];
      const workflows = fakeWorkflowsStore(rows);
      const runtime = fakeMastra({ workflows: workflows.store });
      const adapter = metricsAdapter({ mastra: runtime.mastra });
      const docs = await adapter.raw<MastraRunMetricModel[], true>(
        { kind: "runs", workflowName: "wf-b" },
        true
      );
      expect(docs[0].workflowId).toBe("wf-b");
    });
  });

  describe("raw scores reads", () => {
    const scoreRows = (): MastraStorageScoreRow[] => [
      {
        id: "score-1",
        runId: "run-1",
        scorerId: "my-scorer",
        score: 0.5,
        input: { foo: "bar" },
        createdAt: new Date("2026-01-01T10:00:00Z"),
      },
      // Unprojectable: no id.
      { runId: "run-1", scorerId: "s", score: 1, createdAt: new Date() },
    ];

    it("fails closed without a run id and serves rows through the real domain contract", async () => {
      const calls: unknown[] = [];
      const scoresStore: MastraMetricsScoresStoreLike = {
        listScoresByRunId: async (input) => {
          calls.push(input);
          return {
            scores: scoreRows(),
            pagination: { total: 7 },
          } as never;
        },
      };
      const runtime = fakeMastra({ scores: scoresStore });
      const adapter = metricsAdapter({ mastra: runtime.mastra });

      await expect(
        adapter.raw({ kind: "scores", workflowName: "wf-a" }, true)
      ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_METRICS_UNAVAILABLE });

      const rows = await adapter.raw<MastraScoreMetricModel[], true>(
        { kind: "scores", workflowName: "wf-a", runId: "run-1" },
        true
      );
      expect(calls[0]).toEqual({
        runId: "run-1",
        pagination: { page: 0, perPage: false },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].scoreId).toBe("score-1");
      expect(rows[0].workflowId).toBe("wf-a");

      const enveloped = await adapter.raw<MastraScoreMetricModel[], false>(
        { kind: "scores", workflowName: "wf-a", runId: "run-1" },
        false
      );
      expect(enveloped.count).toBe(7);
      expect(enveloped.data).toHaveLength(1);
    });
  });

  describe("raw traces reads", () => {
    const spanRows = (): MastraStorageSpanRow[] => [
      {
        traceId: "trace-1",
        spanId: "span-1",
        runId: "run-1",
        name: "root",
        spanType: "workflow",
        status: "success",
        attributes: { a: 1 },
        startedAt: new Date("2026-01-01T10:00:00Z"),
      },
      // Unprojectable: no run id (cannot be owner-scoped).
      { traceId: "trace-1", spanId: "span-2", name: "child" },
    ];

    it("fails closed without a run id and serves spans through the real domain contract", async () => {
      const calls: unknown[] = [];
      const obsStore: MastraMetricsObservabilityStoreLike = {
        listTraces: async (args) => {
          calls.push(args);
          return {
            spans: spanRows(),
            pagination: { total: 3 },
          } as never;
        },
      };
      const runtime = fakeMastra({ observability: obsStore });
      const adapter = metricsAdapter({ mastra: runtime.mastra });

      await expect(
        adapter.raw({ kind: "traces", workflowName: "wf-a" }, true)
      ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_METRICS_UNAVAILABLE });

      const rows = await adapter.raw<MastraTraceMetricModel[], true>(
        { kind: "traces", workflowName: "wf-a", runId: "run-1", page: 2, perPage: 10 },
        true
      );
      expect(calls[0]).toEqual({
        mode: "page",
        filters: { runId: "run-1" },
        pagination: { page: 2, perPage: 10 },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].spanId).toBe("span-1");
      expect(rows[0].summary).toEqual({ attributes: { a: 1 } });
    });
  });

  describe("single-row reads", () => {
    it("reads a run through getWorkflowRunById and fails closed on misses", async () => {
      const row: MastraStorageRunRow = {
        runId: "run-1",
        workflowName: "wf-a",
        snapshot: { status: "success" },
        createdAt: new Date(),
      };
      const workflows = fakeWorkflowsStore([], { "run-1": row });
      const runtime = fakeMastra({ workflows: workflows.store });
      const adapter = metricsAdapter({ mastra: runtime.mastra });

      const read = await adapter.read(MastraRunMetricModel, "run-1");
      expect(read.runId).toBe("run-1");
      expect(workflows.calls[0]).toEqual({ runId: "run-1" });

      await expect(adapter.read(MastraRunMetricModel, "missing")).rejects.toBeInstanceOf(
        NotFoundError
      );

      // Unprojectable row (no createdAt): skipped, never fabricated.
      const workflowsBroken = fakeWorkflowsStore([], {
        "run-1": { runId: "run-1", workflowName: "wf-a" },
      });
      const brokenAdapter = metricsAdapter({ mastra: fakeMastra({ workflows: workflowsBroken.store }).mastra });
      await expect(brokenAdapter.read(MastraRunMetricModel, "run-1")).rejects.toBeInstanceOf(
        NotFoundError
      );
    });

    it("reads a score through getScoreById and fails closed without the method", async () => {
      const scoresStore = {
        listScoresByRunId: async () => ({ scores: [], pagination: { total: 0 } }),
        getScoreById: async ({ id }: { id: string }) =>
          id === "score-1"
            ? {
                id: "score-1",
                runId: "run-1",
                scorerId: "s",
                score: 1,
                createdAt: new Date(),
              }
            : null,
      };
      const runtime = fakeMastra({ scores: scoresStore });
      const adapter = metricsAdapter({ mastra: runtime.mastra });
      const read = await adapter.read(MastraScoreMetricModel, "score-1");
      expect(read.scoreId).toBe("score-1");
      await expect(adapter.read(MastraScoreMetricModel, "missing")).rejects.toBeInstanceOf(
        NotFoundError
      );

      const noLookup = fakeMastra({ scores: { listScoresByRunId: async () => ({}) } });
      const noLookupAdapter = metricsAdapter({ mastra: noLookup.mastra });
      await expect(
        noLookupAdapter.read(MastraScoreMetricModel, "score-1")
      ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_METRICS_UNAVAILABLE });
    });

    it("fails closed for unsupported model kinds", async () => {
      const runtime = fakeMastra({ observability: {} });
      const adapter = metricsAdapter({ mastra: runtime.mastra });
      await expect(
        adapter.read(MastraTraceMetricModel, "span-1")
      ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_METRICS_UNAVAILABLE });
    });
  });

  describe("paginator/statement construction", () => {
    it("builds the dedicated statement and paginator", () => {
      const runtime = fakeMastra({});
      const adapter = metricsAdapter({ mastra: runtime.mastra });
      const statement = adapter.Statement<MastraRunMetricModel>();
      expect(statement).toBeDefined();
      const query: MastraMetricsQuery = { kind: "runs", workflowName: "wf-a" };
      const paginator = adapter.Paginator<MastraRunMetricModel>(
        query,
        5,
        MastraRunMetricModel
      );
      expect(paginator).toBeDefined();
    });
  });
});
