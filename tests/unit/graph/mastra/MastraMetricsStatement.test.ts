/**
 * @module as-graph/tests/unit/graph/mastra/MastraMetricsStatement
 * @summary Unit evidence for the mastra metrics statement + paginator
 * (SAA-836 S2).
 * @description Proves the fail-closed query contract (equality filters only on
 * the allowlisted attributes per kind, no aggregations/grouping/distinct,
 * `createdAt` ordering only) and the scoping carriers (`forWorkflow`/`forRun`),
 * plus the paginator's mastra-native page mapping: the one-indexed decaf page
 * is served through the zero-indexed mastra page, out-of-range pages fail with
 * `PagingError`, and an empty page is `[]` — never nil (R7).
 */
import { Model } from "@decaf-ts/decorator-validation";
import type { Constructor } from "@decaf-ts/decoration";
import {
  Condition,
  PagingError,
  QueryError,
} from "@decaf-ts/core";
import {
  MastraMetricsAdapter,
  type MastraMetricsQuery,
} from "../../../../src/mastra/MastraMetricsAdapter";
import {
  MastraMetricsPaginator,
  MastraMetricsStatement,
  mastraMetricsKindOf,
} from "../../../../src/mastra/MastraMetricsStatement";
import {
  MastraRunMetricModel,
  MastraScoreMetricModel,
  MastraTraceMetricModel,
  type MastraStorageRunRow,
} from "../../../../src/mastra/MastraMetricsModels";

/** Exposes the protected `build()` so the fail-closed contract is asserted on the exact query. */
class ExposedMetricsStatement<M extends Model> extends MastraMetricsStatement<M> {
  builtQuery(): MastraMetricsQuery {
    return this.build();
  }
}

/** A fake mastra runtime whose workflows domain serves the given rows (page-honoring) and records calls. */
function fakeMastraWithRuns(rows: MastraStorageRunRow[]) {
  const calls: unknown[] = [];
  const workflowsStore = {
    listWorkflowRuns: async (args: {
      workflowName?: string;
      page?: number;
      perPage?: number | false;
    }) => {
      calls.push(args);
      const perPage = args.perPage === undefined ? rows.length : args.perPage;
      const page = args.page ?? 0;
      const sliced =
        perPage === false ? rows : rows.slice(page * perPage, (page + 1) * perPage);
      return { runs: sliced, total: rows.length };
    },
    getWorkflowRunById: async () => null,
  };
  return {
    calls,
    mastra: {
      getStorage: () => ({
        getStore: (domain: string) =>
          Promise.resolve(domain === "workflows" ? workflowsStore : undefined),
      }),
    },
  };
}

/** N deterministic run rows for a workflow, in the order mastra returns them. */
function runRows(count: number, workflowName = "wf-a"): MastraStorageRunRow[] {
  return Array.from({ length: count }, (_, index) => ({
    runId: `run-${index + 1}`,
    workflowName,
    snapshot: { status: "success" },
    createdAt: new Date(Date.UTC(2026, 0, 1, 10, 0, index)),
  }));
}

/** Unique-alias adapter factory: the Decaf adapter registry rejects duplicate flavour aliases. */
let ADAPTER_SEQUENCE = 0;
function metricsAdapter(config: { mastra: unknown } = { mastra: {} }): MastraMetricsAdapter {
  return new MastraMetricsAdapter(config, `mastra-metrics-test-${++ADAPTER_SEQUENCE}`);
}

describe("MastraMetricsStatement (SAA-836 S2)", () => {
  describe("kind resolution", () => {
    it("maps each metric model onto its mastra storage kind", () => {
      expect(mastraMetricsKindOf(MastraRunMetricModel)).toBe("runs");
      expect(mastraMetricsKindOf(MastraScoreMetricModel)).toBe("scores");
      expect(mastraMetricsKindOf(MastraTraceMetricModel)).toBe("traces");
    });

    it("fails closed for a non-metrics model class", () => {
      class NotAMetric {}
      expect(() =>
        mastraMetricsKindOf(NotAMetric as unknown as Constructor<MastraRunMetricModel>)
      ).toThrow(QueryError);
    });
  });

  describe("scoping carriers", () => {
    it("carries the workflow scope and the optional run narrowing in the built query", () => {
      const adapter = metricsAdapter();
      const statement = new ExposedMetricsStatement(adapter)
        .forWorkflow("wf-a")
        .forRun("run-1");
      statement.from(MastraScoreMetricModel);
      expect(statement.builtQuery()).toEqual({
        kind: "scores",
        workflowName: "wf-a",
        runId: "run-1",
      });
    });

    it("builds an unscoped plain read when nothing is set", () => {
      const adapter = metricsAdapter();
      const statement = new ExposedMetricsStatement(adapter);
      statement.from(MastraRunMetricModel);
      expect(statement.builtQuery()).toEqual({
        kind: "runs",
        workflowName: "",
      });
    });
  });

  describe("fail-closed filters", () => {
    it("accepts the allowlisted equality filter for runs (status)", () => {
      const adapter = metricsAdapter();
      const statement = new ExposedMetricsStatement(adapter).forWorkflow("wf-a");
      statement.from(MastraRunMetricModel);
      statement.where(Condition.attr("status").eq("success"));
      expect(statement.builtQuery().status).toBe("success");
    });

    it("fails closed on a non-equality operator", () => {
      const adapter = metricsAdapter();
      const statement = new ExposedMetricsStatement(adapter).forWorkflow("wf-a");
      statement.from(MastraRunMetricModel);
      statement.where(Condition.attr("status").gt("success"));
      expect(() => statement.builtQuery()).toThrow(
        /support equality filters only/
      );
    });

    it("fails closed on an attribute the kind does not allowlist", () => {
      const adapter = metricsAdapter();
      const runs = new ExposedMetricsStatement(adapter).forWorkflow("wf-a");
      runs.from(MastraRunMetricModel);
      runs.where(Condition.attr("runId").eq("run-1"));
      expect(() => runs.builtQuery()).toThrow(/do not support filtering 'runId'/);

      const scores = new ExposedMetricsStatement(adapter).forWorkflow("wf-a");
      scores.from(MastraScoreMetricModel);
      scores.where(Condition.attr("status").eq("success"));
      expect(() => scores.builtQuery()).toThrow(/do not support filtering 'status'/);
    });

    it("fails closed on a non-string status comparison", () => {
      const adapter = metricsAdapter();
      const statement = new ExposedMetricsStatement(adapter).forWorkflow("wf-a");
      statement.from(MastraRunMetricModel);
      statement.where(Condition.attr("status").eq(1 as unknown as string));
      expect(() => statement.builtQuery()).toThrow(
        /status filters require a non-empty string/
      );
    });

    it("fails closed on aggregations, grouping, and distinct", () => {
      const adapter = metricsAdapter();
      const aggregated = new ExposedMetricsStatement(adapter);
      aggregated.from(MastraRunMetricModel);
      aggregated.count("runId");
      expect(() => aggregated.builtQuery()).toThrow(/plain reads only/);

      const grouped = new ExposedMetricsStatement(adapter);
      grouped.from(MastraRunMetricModel);
      grouped.groupBy("status");
      expect(() => grouped.builtQuery()).toThrow(/plain reads only/);
    });

    it("fails closed on a selector-less count() aggregation", () => {
      // A zero-arg `count()` records a null `countSelector`; the fail-closed
      // guard must still reject it instead of silently degrading the read.
      const adapter = metricsAdapter();
      const selectorless = new ExposedMetricsStatement(adapter);
      selectorless.from(MastraRunMetricModel);
      selectorless.count();
      expect(() => selectorless.builtQuery()).toThrow(/plain reads only/);
    });

    it("accepts createdAt ordering and fails closed on any other attribute", () => {
      const adapter = metricsAdapter();
      const ordered = new ExposedMetricsStatement(adapter);
      ordered.from(MastraRunMetricModel);
      ordered.orderBy("createdAt", "DESC");
      expect(() => ordered.builtQuery()).not.toThrow();

      const badOrder = new ExposedMetricsStatement(adapter);
      badOrder.from(MastraRunMetricModel);
      badOrder.orderBy("runId", "DESC");
      expect(() => badOrder.builtQuery()).toThrow(
        /createdAt ordering only/
      );
    });
  });

  describe("execution over the adapter", () => {
    it("serves the scoped rows as projected models", async () => {
      const runtime = fakeMastraWithRuns(runRows(3));
      const adapter = metricsAdapter({ mastra: runtime.mastra });
      const statement = new MastraMetricsStatement(adapter)
        .forWorkflow("wf-a")
        .from(MastraRunMetricModel);
      const rows = await statement.execute();
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toBeInstanceOf(MastraRunMetricModel);
        expect(row.workflowId).toBe("wf-a");
      }
    });
  });
});

describe("MastraMetricsPaginator (SAA-836 S2)", () => {
  it("maps the one-indexed decaf page onto the zero-indexed mastra page", async () => {
    const rows = runRows(5);
    const runtime = fakeMastraWithRuns(rows);
    const adapter = metricsAdapter({ mastra: runtime.mastra });
    const statement = new MastraMetricsStatement(adapter)
      .forWorkflow("wf-a")
      .from(MastraRunMetricModel);
    const paginator = await statement.paginate(2);
    expect(paginator).toBeInstanceOf(MastraMetricsPaginator);

    const page2 = await paginator.page(2);
    expect(runtime.calls[0]).toEqual({
      workflowName: "wf-a",
      page: 1, // page 2 (one-indexed decaf) → 1 (zero-indexed mastra)
      perPage: 2,
    });
    expect(page2.map((row) => row.runId)).toEqual(["run-3", "run-4"]);
    expect(paginator.current).toBe(2);
    expect(paginator.count).toBe(5);
    expect(paginator.total).toBe(3);
  });

  it("fails closed on page numbers below 1", async () => {
    const runtime = fakeMastraWithRuns(runRows(2));
    const adapter = metricsAdapter({ mastra: runtime.mastra });
    const statement = new MastraMetricsStatement(adapter)
      .forWorkflow("wf-a")
      .from(MastraRunMetricModel);
    const paginator = await statement.paginate(2);
    await expect(paginator.page(0)).rejects.toBeInstanceOf(PagingError);
    await expect(paginator.page(-1)).rejects.toBeInstanceOf(PagingError);
  });

  it("fails closed on an out-of-range page", async () => {
    const runtime = fakeMastraWithRuns(runRows(5));
    const adapter = metricsAdapter({ mastra: runtime.mastra });
    const statement = new MastraMetricsStatement(adapter)
      .forWorkflow("wf-a")
      .from(MastraRunMetricModel);
    const paginator = await statement.paginate(2);
    await expect(paginator.page(4)).rejects.toBeInstanceOf(PagingError);
  });

  it("serves an empty result as an empty array — never nil (R7)", async () => {
    const runtime = fakeMastraWithRuns([]);
    const adapter = metricsAdapter({ mastra: runtime.mastra });
    const statement = new MastraMetricsStatement(adapter)
      .forWorkflow("wf-a")
      .from(MastraRunMetricModel);
    const paginator = await statement.paginate(10);
    const page = await paginator.page(1);
    expect(page).toEqual([]);
    expect(paginator.count).toBe(0);
    expect(paginator.current).toBe(1);
  });
});
