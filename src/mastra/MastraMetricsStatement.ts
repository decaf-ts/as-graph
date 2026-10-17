/**
 * @module as-graph/mastra/MastraMetricsStatement
 * @summary Dedicated Decaf statement + paginator over the mastra metrics
 * adapter (SAA-836 S2).
 * @description The statement builds the raw {@link MastraMetricsQuery} the
 * read-only adapter executes against the real mastra storage, and the paginator
 * pages its results with mastra-native pagination where the domain supports it.
 * Both fail closed: unsupported attributes, operators, or orderings raise a
 * `QueryError` instead of silently degrading the query.
 */
import {
  Condition,
  Operator,
  PagingError,
  QueryError,
  Statement,
  Paginator,
  type AdapterFlags,
  type Context,
  type ContextualArgs,
} from "@decaf-ts/core";
import { Model } from "@decaf-ts/decorator-validation";
import type { Constructor } from "@decaf-ts/decoration";
import type {
  MastraMetricModel,
} from "./MastraMetricsModels";
import {
  MastraRunMetricModel,
  MastraScoreMetricModel,
  MastraTraceMetricModel,
} from "./MastraMetricsModels";
import type {
  MastraMetricsAdapter,
  MastraMetricsQuery,
} from "./MastraMetricsAdapter";

/**
 * Maps a metric model class onto the mastra storage kind its query targets.
 *
 * @param clazz - The metric model class to map.
 * @returns The mastra storage kind (`runs`, `scores`, or `traces`).
 * @throws {QueryError} when the class is not one of the three metric models.
 */
export function mastraMetricsKindOf(
  clazz: Constructor<MastraMetricModel>
): "runs" | "scores" | "traces" {
  if (clazz === (MastraRunMetricModel as unknown as Constructor<MastraMetricModel>))
    return "runs";
  if (clazz === (MastraScoreMetricModel as unknown as Constructor<MastraMetricModel>))
    return "scores";
  if (clazz === (MastraTraceMetricModel as unknown as Constructor<MastraMetricModel>))
    return "traces";
  throw new QueryError(
    "Mastra metrics statements support the run, score, and trace metric models only"
  );
}

/**
 * The attributes a metrics statement may filter on, per kind. Anything else
 * fails closed: there is no honest mastra storage mapping for it.
 */
const MASTRA_METRICS_FILTERABLE: Record<
  "runs" | "scores" | "traces",
  readonly string[]
> = {
  runs: ["status"],
  scores: [],
  traces: [],
};

/**
 * Dedicated read-only statement over the mastra metrics adapter (SAA-836 S2).
 *
 * `from()` selects one of the three metric models, `where()` accepts only the
 * documented filterable attributes of the selected kind, and `execute()`
 * delegates to the adapter's real mastra storage read. `paginate(size)` returns
 * a {@link MastraMetricsPaginator} that serves the query pages.
 */
export class MastraMetricsStatement<M extends Model> extends Statement<
  M,
  MastraMetricsAdapter,
  M[],
  MastraMetricsQuery
> {
  /** The canonical workflow id (mastra workflow_name) the query is scoped to. */
  private metricsWorkflowName?: string;

  /** The optional run id the query is narrowed to (scores/traces). */
  private metricsRunId?: string;

  /**
   * Builds the statement over the read-only metrics adapter.
   *
   * @param adapter - The mastra metrics adapter the statement executes against.
   * @param overrides - Optional adapter flag overrides.
   */
  constructor(adapter: MastraMetricsAdapter, overrides?: Partial<AdapterFlags>) {
    super(adapter, overrides);
  }

  /**
   * Scopes the statement to one canonical workflow (mastra storage
   * workflow_name). The caller (the metrics gateway) has already resolved the
   * workflow's ownership; the statement only carries the scope.
   *
   * @param workflowId - The canonical workflow id to scope the query to.
   * @returns This statement, for chaining.
   */
  forWorkflow(workflowId: string): this {
    this.metricsWorkflowName = workflowId;
    return this;
  }

  /**
   * Narrows the statement to one mastra run (required for score and trace
   * reads, which mastra serves per run).
   *
   * @param runId - The mastra run id to narrow to.
   * @returns This statement, for chaining.
   */
  forRun(runId: string): this {
    this.metricsRunId = runId;
    return this;
  }

  /**
   * Parses the statement's single `where` condition into its query fragment.
   * Only equality on a documented filterable attribute of the selected kind is
   * accepted; everything else fails closed.
   *
   * @param condition - The decaf condition built by the statement chain.
   * @returns The query fragment carrying the validated status filter.
   * @throws {QueryError} when the operator is not `eq`, the attribute is not filterable for the kind, or the comparison is not a non-empty string.
   */
  protected parseCondition(condition: Condition<M>): MastraMetricsQuery {
    const { attr1, operator, comparison } = condition as unknown as {
      attr1: string;
      operator: string;
      comparison: unknown;
    };
    // Decaf `Condition.attr(...).eq(...)` emits `Operator.EQUAL` ("EQUAL"),
    // not the lowercase `eq`; normalize the case so the only allowlisted
    // operator (equality) is actually reachable.
    if (String(operator).toUpperCase() !== Operator.EQUAL) {
      throw new QueryError(
        `Mastra metrics statements support equality filters only (received '${operator}')`
      );
    }
    const kind = mastraMetricsKindOf(
      this.fromSelector as unknown as Constructor<MastraMetricModel>
    );
    if (!MASTRA_METRICS_FILTERABLE[kind].includes(attr1)) {
      throw new QueryError(
        `Mastra metrics statements do not support filtering '${String(attr1)}' for ${kind}`
      );
    }
    if (typeof comparison !== "string" || !comparison) {
      throw new QueryError(
        "Mastra metrics status filters require a non-empty string"
      );
    }
    return { kind, workflowName: "", status: comparison };
  }

  /**
   * Builds the raw {@link MastraMetricsQuery} the adapter executes. Rejects
   * aggregations, grouping, distinct, and non-`createdAt` orderings; the
   * workflow scope and optional run narrowing are appended to the parsed
   * condition fragment, and decaf `limit`/`offset` map onto the mastra-native
   * `perPage`/`page`.
   *
   * @returns The raw metrics query.
   * @throws {QueryError} when the statement uses an unsupported shape.
   */
  protected build(): MastraMetricsQuery {
    // Guard on presence, not truthiness: a selector-less `count()` records
    // `countSelector = null` — `null` means "aggregation requested", so only
    // `undefined` counts as absent.
    if (
      this.countSelector !== undefined ||
      this.countDistinctSelector !== undefined ||
      this.minSelector !== undefined ||
      this.maxSelector !== undefined ||
      this.sumSelector !== undefined ||
      this.avgSelector !== undefined ||
      this.distinctSelector !== undefined ||
      this.groupBySelectors?.length
    ) {
      throw new QueryError(
        "Mastra metrics statements support plain reads only (no aggregations, grouping, or distinct)"
      );
    }
    if (this.orderBySelectors?.length) {
      for (const [key] of this.orderBySelectors) {
        if (key !== "createdAt") {
          throw new QueryError(
            `Mastra metrics statements support createdAt ordering only (received '${String(key)}')`
          );
        }
      }
    }
    const kind = mastraMetricsKindOf(
      this.fromSelector as unknown as Constructor<MastraMetricModel>
    );
    const scoped: MastraMetricsQuery = this.whereCondition
      ? this.parseCondition(this.whereCondition)
      : { kind, workflowName: "" };
    return {
      ...scoped,
      workflowName: this.metricsWorkflowName ?? "",
      ...(this.metricsRunId ? { runId: this.metricsRunId } : {}),
      ...(this.limitSelector !== undefined
        ? { perPage: this.limitSelector }
        : {}),
      ...(this.offsetSelector !== undefined
        ? { page: this.offsetSelector }
        : {}),
    };
  }
}

/**
 * Dedicated paginator over the mastra metrics adapter (SAA-836 S2). Pages are
 * mastra-native: the paginator maps the one-indexed decaf page onto the
 * zero-indexed mastra page and derives the record count and page total from
 * the storage response. R7: a page never resolves to nil rows — an empty
 * result is an empty array, never null/undefined.
 */
export class MastraMetricsPaginator<M extends Model> extends Paginator<
  M,
  M[],
  MastraMetricsQuery
> {
  /**
   * Builds the paginator over the read-only metrics adapter.
   *
   * @param adapter - The mastra metrics adapter the paginator reads through.
   * @param query - The raw metrics query to page over.
   * @param size - Records per page.
   * @param clazz - The metric model class being paged.
   */
  constructor(
    adapter: MastraMetricsAdapter,
    query: MastraMetricsQuery,
    size: number,
    clazz: Constructor<M>
  ) {
    super(adapter, query, size, clazz);
  }

  /**
   * Copies the raw query unmodified: the mastra query already carries the
   * mastra-native pagination fields the adapter expects.
   *
   * @param rawStatement - The query the paginator was built with.
   * @returns The prepared query.
   */
  protected prepare(rawStatement: MastraMetricsQuery): MastraMetricsQuery {
    return { ...rawStatement };
  }

  /**
   * Reads one page through the adapter's real mastra storage read.
   *
   * @param page - The one-indexed page number to read.
   * @returns The page's model rows, newest first as mastra returns them.
   * @throws {PagingError} when the page is out of the known range.
   */
  override async page(page: number = 1, ...args: ContextualArgs<Context>): Promise<M[]> {
    if (page < 1 || !Number.isInteger(page)) {
      throw new PagingError(
        "Page number cannot be under 1 and must be an integer"
      );
    }
    const { ctxArgs } = this.adapter["logCtx"](args, this.page);
    const query = this.prepare(this.query as MastraMetricsQuery);
    const results = (await this.adapter.raw<M[], false>(
      { ...query, page: page - 1, perPage: this.size },
      false,
      ...(ctxArgs as ContextualArgs<Context>)
    )) as unknown as { data: M[]; count?: number };
    const data = results.data ?? [];
    this._recordCount = results.count ?? data.length;
    this._totalPages = Math.max(1, Math.ceil(this._recordCount / this.size));
    this.validatePage(page);
    this._currentPage = page;
    const pkName = Model.pk(this.clazz) as string;
    const bookmark = data.length
      ? (data[data.length - 1] as unknown as Record<string, unknown>)[pkName]
      : undefined;
    this._bookmark =
      typeof bookmark === "string" || typeof bookmark === "number"
        ? bookmark
        : undefined;
    return data;
  }
}
