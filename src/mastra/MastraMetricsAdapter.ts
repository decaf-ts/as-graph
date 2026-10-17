/**
 * @module as-graph/mastra/MastraMetricsAdapter
 * @summary Dedicated read-only Decaf adapter over the mastra storage (SAA-836 S2).
 * @description The S2 adapter is the persistence seam between the read-only
 * mastra metrics models and the host-provided `@mastra/core` storage. It is
 * deliberately a direct-library wrap (SAA-836 R2 justification): mastra owns
 * runs, scores and traces as the source of truth (R3 mastra-first, R9
 * resource-output preferred), so the adapter delegates every read to the real
 * mastra storage domains instead of mirroring them. Writes fail closed: the
 * models are read-only projections and the adapter refuses every mutation.
 *
 * Read flow: {@link MastraMetricsStatement} builds a {@link MastraMetricsQuery},
 * the adapter executes it against the mastra `workflows`/`scores`/`observability`
 * domains and projects every returned row into its read-only model shape; rows
 * that cannot be projected are skipped, never fabricated.
 */
import {
  Adapter,
  RawResult,
  UnsupportedError,
  type AdapterFlags,
  type Context,
  type ContextualArgs,
  type PreparedStatement,
} from "@decaf-ts/core";
import { Model } from "@decaf-ts/decorator-validation";
import type { Constructor } from "@decaf-ts/decoration";
import { NotFoundError, type PrimaryKeyType } from "@decaf-ts/db-decorators";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  MastraRunMetricModel,
  MastraScoreMetricModel,
  mastraRunRowToModel,
  mastraScoreRowToModel,
  mastraSpanRowToModel,
  type MastraMetricModel,
  type MastraStorageRunRow,
  type MastraStorageScoreRow,
  type MastraStorageSpanRow,
} from "./MastraMetricsModels";
import { MastraMetricsStatement } from "./MastraMetricsStatement";
import { MastraMetricsPaginator } from "./MastraMetricsStatement";
import { GRAPH_MASTRA_METRICS_UNAVAILABLE, GRAPH_MASTRA_METRICS_READ_ONLY } from "./types";

/** The flavour id the read-only mastra metrics adapter registers under. */
export const MASTRA_METRICS_FLAVOUR = "mastra-metrics";

/** The mastra runtime structural surface the adapter reads through. */
export interface MastraMetricsRuntimeLike {
  /** Real mastra runtime accessor returning the composite storage, when present. */
  getStorage?: () => unknown;
}

/**
 * Host-provided mastra storage composite store (structural subset of the real
 * `@mastra/core` storage contract). Domains are resolved lazily per read.
 */
export interface MastraMetricsCompositeStoreLike {
  /** Resolves one storage domain by name, or `undefined` when absent. */
  getStore: (domain: string) => Promise<unknown | undefined>;
}

/** Mastra workflows storage domain (structural subset of the real contract). */
export interface MastraMetricsWorkflowsStoreLike {
  listWorkflowRuns: (args: {
    workflowName?: string;
    perPage?: number | false;
    page?: number;
  }) => Promise<{ runs: unknown[]; total: number }>;
  getWorkflowRunById: (args: {
    runId: string;
    workflowName?: string;
  }) => Promise<unknown | null>;
}

/** Mastra scores storage domain (structural subset of the real contract). */
export interface MastraMetricsScoresStoreLike {
  listScoresByRunId: (input: {
    runId: string;
    pagination: { page: number; perPage: number | false };
  }) => Promise<{ scores: unknown[]; pagination: { total: number } }>;
}

/** Mastra observability storage domain (structural subset of the real contract). */
export interface MastraMetricsObservabilityStoreLike {
  listTraces: (args: {
    mode?: string;
    filters?: { runId?: string };
    pagination?: { page?: number; perPage?: number };
  }) => Promise<{
    spans: unknown[];
    pagination?: { total?: number; page?: number; perPage?: number; hasMore?: boolean };
  }>;
}

/** The raw query the metrics statement builds and the adapter executes. */
export interface MastraMetricsQuery {
  /** Which mastra storage domain the query targets. */
  kind: "runs" | "scores" | "traces";
  /** Canonical workflow id the query is scoped to (mastra workflow_name). */
  workflowName: string;
  /** The single run id scores/traces queries are narrowed to. */
  runId?: string;
  /** Optional status narrowing (runs only). */
  status?: string;
  /** Zero-indexed mastra-native page (runs) / one-indexed page (scores, traces). */
  page?: number;
  /** Records per page; `false` fetches all rows the domain can return. */
  perPage?: number | false;
}

/**
 * Resolves the mastra storage composite store from a wired runtime; fails
 * closed when the runtime exposes no storage at all.
 *
 * @param runtime - The host-wired mastra runtime (or any value).
 * @returns The composite storage store.
 * @throws {GraphExecutionError} with {@link GRAPH_MASTRA_METRICS_UNAVAILABLE} when the runtime exposes no storage.
 */
export function mastraMetricsStorageOf(
  runtime: unknown
): MastraMetricsCompositeStoreLike {
  const candidate = runtime as MastraMetricsRuntimeLike | undefined;
  const storage = candidate?.getStorage?.();
  if (!storage || typeof (storage as MastraMetricsCompositeStoreLike).getStore !== "function") {
    throw new GraphExecutionError(
      "Mastra metrics reads require the wired Mastra runtime to expose storage",
      GRAPH_MASTRA_METRICS_UNAVAILABLE
    );
  }
  return storage as MastraMetricsCompositeStoreLike;
}

/**
 * Resolves one mastra storage domain; fails closed when the domain is absent.
 *
 * @param storage - The composite storage store resolved from the runtime.
 * @param domain - The storage domain to resolve (`workflows`, `scores`, or `observability`).
 * @returns The domain store.
 * @throws {GraphExecutionError} with {@link GRAPH_MASTRA_METRICS_UNAVAILABLE} when the domain is absent.
 */
async function mastraMetricsDomainStoreOf(
  storage: MastraMetricsCompositeStoreLike,
  domain: "workflows" | "scores" | "observability"
): Promise<unknown> {
  const store = await storage.getStore(domain);
  if (!store) {
    throw new GraphExecutionError(
      `Mastra storage exposes no '${domain}' domain for metrics reads`,
      GRAPH_MASTRA_METRICS_UNAVAILABLE
    );
  }
  return store;
}

/**
 * Dedicated read-only Decaf adapter over the host-provided mastra storage
 * (SAA-836 S2). Every mutation fails closed with a read-only error; every read
 * delegates to the real mastra storage domains and projects rows into the
 * read-only metric models. R7: converters never emit null rows — a row that
 * cannot be projected is skipped, never fabricated.
 */
export class MastraMetricsAdapter extends Adapter<
  { mastra: unknown },
  unknown,
  MastraMetricsQuery,
  Context
> {
  /**
   * Builds the adapter over the host-provided mastra runtime.
   *
   * @param config - Adapter configuration carrying the wired mastra runtime.
   * @param alias - Optional adapter alias (the backend supplies a unique one per gateway).
   */
  constructor(config: { mastra: unknown }, alias?: string) {
    super(config, MASTRA_METRICS_FLAVOUR, alias);
  }

  /**
   * Builds the dedicated read-only metrics statement.
   *
   * @param overrides - Optional adapter flag overrides.
   * @returns The statement bound to this adapter.
   */
  override Statement<M extends Model>(
    overrides?: Partial<AdapterFlags>
  ): MastraMetricsStatement<M> {
    return new MastraMetricsStatement<M>(this, overrides);
  }

  /**
   * Builds the dedicated mastra-native paginator.
   *
   * @param query - The metrics query (or prepared statement) to page over.
   * @param size - Records per page.
   * @param clazz - The metric model class being paged.
   * @returns The paginator bound to this adapter.
   */
  override Paginator<M extends Model>(
    query: MastraMetricsQuery | PreparedStatement<M>,
    size: number,
    clazz: Constructor<M>
  ): MastraMetricsPaginator<M> {
    return new MastraMetricsPaginator<M>(this, query as MastraMetricsQuery, size, clazz);
  }

  /**
   * Passes storage/transport errors through unchanged: the mastra domains
   * already raise decaf-compatible errors and the adapter adds no mapping.
   *
   * @param err - The error raised by the storage read.
   * @returns The same error, typed for the adapter contract.
   */
  parseError<E extends Error>(err: Error): E {
    return err as E;
  }

  /**
   * Writes fail closed: the metrics models are read-only projections.
   *
   * @throws {UnsupportedError} always, with {@link GRAPH_MASTRA_METRICS_READ_ONLY}.
   */
  override async create(): Promise<Record<string, any>> {
    throw new UnsupportedError(
      `Mastra metrics models are read-only: create is not supported (${GRAPH_MASTRA_METRICS_READ_ONLY})`
    );
  }

  /**
   * Writes fail closed: the metrics models are read-only projections.
   *
   * @throws {UnsupportedError} always, with {@link GRAPH_MASTRA_METRICS_READ_ONLY}.
   */
  override async update(): Promise<Record<string, any>> {
    throw new UnsupportedError(
      `Mastra metrics models are read-only: update is not supported (${GRAPH_MASTRA_METRICS_READ_ONLY})`
    );
  }

  /**
   * Writes fail closed: the metrics models are read-only projections.
   *
   * @throws {UnsupportedError} always, with {@link GRAPH_MASTRA_METRICS_READ_ONLY}.
   */
  override async delete(): Promise<Record<string, any>> {
    throw new UnsupportedError(
      `Mastra metrics models are read-only: delete is not supported (${GRAPH_MASTRA_METRICS_READ_ONLY})`
    );
  }

  /**
   * Reads one metric row by id through the real mastra storage. Runs resolve
   * via `getWorkflowRunById` and scores via `getScoreById`; unsupported model
   * kinds fail closed. Trace rows are not addressable by id (mastra serves
   * them per run), so only run and score lookups are supported.
   *
   * @param clazz - The metric model class being read.
   * @param id - The mastra row id.
   * @param _args - Variadic decaf contextual arguments accepted for
   *   signature compatibility with the base adapter contract only; the
   *   mastra storage reads carry no context of their own, so the value is
   *   intentionally unused (`void _args;` keeps the lint rule quiet without
   *   changing the forwarded signature).
   * @returns The projected model record.
   * @throws {GraphExecutionError} when the domain is unavailable or the kind is unsupported.
   * @throws {NotFoundError} when the row is absent or not projectable.
   */
  override async read<M extends Model>(
    clazz: Constructor<M>,
    id: PrimaryKeyType,
    ..._args: ContextualArgs<Context>
  ): Promise<Record<string, any>> {
    void _args;
    const storage = mastraMetricsStorageOf(this.config.mastra);
    if (clazz === (MastraRunMetricModel as unknown as Constructor<M>)) {
      const store = (await mastraMetricsDomainStoreOf(storage, "workflows")) as MastraMetricsWorkflowsStoreLike;
      const row = (await store.getWorkflowRunById({
        runId: String(id),
      })) as MastraStorageRunRow | null;
      if (!row) throw new NotFoundError(`No mastra run found for id '${String(id)}'`);
      const model = mastraRunRowToModel(
        row,
        typeof row.workflowName === "string" ? row.workflowName : ""
      );
      if (!model) {
        throw new NotFoundError(`Mastra run '${String(id)}' is not projectable`);
      }
      return model as unknown as Record<string, any>;
    }
    if (clazz === (MastraScoreMetricModel as unknown as Constructor<M>)) {
      const store = (await mastraMetricsDomainStoreOf(storage, "scores")) as MastraMetricsScoresStoreLike & {
        getScoreById?: (args: { id: string }) => Promise<unknown | null>;
      };
      if (typeof store.getScoreById !== "function") {
        throw new GraphExecutionError(
          "Mastra scores storage exposes no getScoreById for metrics reads",
          GRAPH_MASTRA_METRICS_UNAVAILABLE
        );
      }
      const row = (await store.getScoreById({ id: String(id) })) as MastraStorageScoreRow | null;
      if (!row) throw new NotFoundError(`No mastra score found for id '${String(id)}'`);
      const model = mastraScoreRowToModel(row, "");
      if (!model) {
        throw new NotFoundError(`Mastra score '${String(id)}' is not projectable`);
      }
      return model as unknown as Record<string, any>;
    }
    throw new GraphExecutionError(
      "Mastra metrics reads support run and score lookups only",
      GRAPH_MASTRA_METRICS_UNAVAILABLE
    );
  }

  /**
   * Executes a metrics query against the real mastra storage domains and
   * projects every returned row into its read-only model shape. Runs are
   * optionally narrowed by `status`; scores and traces require a run id (the
   * gateway resolves and verifies it first). Projecting rows never emits nulls
   * (R7): non-projectable rows are skipped.
   *
   * @param query - The metrics query to execute.
   * @param docsOnly - When true, returns the projected rows directly; otherwise a {@link RawResult} with the row count.
   * @param _args - Variadic decaf contextual arguments accepted for
   *   signature compatibility with the base adapter contract only; the
   *   mastra storage reads carry no context of their own, so the value is
   *   intentionally unused (`void _args;` keeps the lint rule quiet without
   *   changing the forwarded signature).
   * @returns The projected rows, or a {@link RawResult} carrying them plus the storage-reported count.
   * @throws {GraphExecutionError} when the storage/domain is unavailable, the kind is unknown, or a required run id is missing.
   */
  override async raw<R, D extends boolean>(
    query: MastraMetricsQuery,
    docsOnly: D,
    ..._args: ContextualArgs<Context>
  ): Promise<RawResult<R, D>> {
    void _args;
    const storage = mastraMetricsStorageOf(this.config.mastra);
    const rows: MastraMetricModel[] = [];
    let count = 0;
    if (query.kind === "runs") {
      const store = (await mastraMetricsDomainStoreOf(storage, "workflows")) as MastraMetricsWorkflowsStoreLike;
      const result = await store.listWorkflowRuns({
        ...(query.workflowName ? { workflowName: query.workflowName } : {}),
        ...(query.page !== undefined && query.perPage !== undefined
          ? { page: query.page, perPage: query.perPage }
          : { perPage: false }),
      });
      count = result.total;
      for (const row of result.runs as MastraStorageRunRow[]) {
        const workflowId =
          typeof row.workflowName === "string" && row.workflowName
            ? row.workflowName
            : query.workflowName;
        const model = mastraRunRowToModel(row, workflowId);
        if (!model) continue;
        if (query.status && model.status !== query.status) continue;
        rows.push(model);
      }
    } else if (query.kind === "scores") {
      if (!query.runId) {
        throw new GraphExecutionError(
          "Mastra score metrics reads require a run id",
          GRAPH_MASTRA_METRICS_UNAVAILABLE
        );
      }
      const store = (await mastraMetricsDomainStoreOf(storage, "scores")) as MastraMetricsScoresStoreLike;
      const result = await store.listScoresByRunId({
        runId: query.runId,
        pagination: {
          page: query.page ?? 0,
          ...(query.perPage !== undefined ? { perPage: query.perPage } : { perPage: false }),
        },
      });
      count = result.pagination?.total ?? result.scores.length;
      for (const row of result.scores as MastraStorageScoreRow[]) {
        const model = mastraScoreRowToModel(row, query.workflowName);
        if (model) rows.push(model);
      }
    } else {
      if (!query.runId) {
        throw new GraphExecutionError(
          "Mastra trace metrics reads require a run id",
          GRAPH_MASTRA_METRICS_UNAVAILABLE
        );
      }
      const store = (await mastraMetricsDomainStoreOf(storage, "observability")) as MastraMetricsObservabilityStoreLike;
      const result = await store.listTraces({
        mode: "page",
        filters: { runId: query.runId },
        pagination: {
          ...(query.page !== undefined ? { page: query.page } : {}),
          ...(query.perPage !== undefined && query.perPage !== false
            ? { perPage: query.perPage }
            : {}),
        },
      });
      count = result.pagination?.total ?? result.spans.length;
      for (const row of result.spans as MastraStorageSpanRow[]) {
        const model = mastraSpanRowToModel(row, query.workflowName);
        if (model) rows.push(model);
      }
    }
    const projected = rows as unknown as R;
    return (docsOnly ? projected : { data: projected, count }) as RawResult<R, D>;
  }

  /**
   * The raw mastra client surface the adapter was built over.
   *
   * @returns The wired mastra runtime (untyped: the adapter reads it structurally).
   */
  protected getClient(): unknown {
    return this.config.mastra;
  }
}
