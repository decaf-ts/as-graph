/**
 * @module as-graph/mastra/MastraMetricsGateway
 * @summary Owner-scoped serving gateway + read-only repositories for the
 * mastra metrics models (SAA-836 S2).
 * @description The gateway is the only surface allowed to execute metrics
 * reads: it resolves the canonical workflow's owner through the same C23
 * ownership anchor the mastra catalogue uses, denies foreign-owner and unknown
 * workflows with a constant `NotFoundError`, and serves paginated rows through
 * the dedicated statement/paginator over the read-only adapter.
 *
 * @mermaid
 * sequenceDiagram
 *   autonumber
 *   participant Caller
 *   participant GW as MastraMetricsGateway
 *   participant Anchor as MastraMetricsOwnership
 *   participant Stmt as MastraMetricsStatement
 *   participant Pg as MastraMetricsPaginator
 *   participant Adapter as MastraMetricsAdapter
 *   participant Mastra as Mastra storage domain
 *   Caller->>GW: listRuns/listScores/listTraces(workflowId, callerOwner)
 *   activate GW
 *   GW->>Anchor: resolveWorkflow(workflowId)
 *   Anchor-->>GW: known + owner
 *   alt unknown or foreign owner (C23)
 *     GW-->>Caller: NotFoundError (constant, maps to 404)
 *   end
 *   opt scores/traces
 *     GW->>Adapter: read(runId)
 *     Adapter->>Mastra: getWorkflowRunById(runId)
 *     Mastra-->>Adapter: run row
 *     Adapter-->>GW: run model
 *     alt run missing or foreign workflow
 *       GW-->>Caller: NotFoundError
 *     end
 *   end
 *   GW->>Stmt: forWorkflow(workflowId).forRun(runId).from(model)
 *   activate Stmt
 *   GW->>Pg: statement.paginate(size)
 *   deactivate Stmt
 *   activate Pg
 *   GW->>Pg: page(n)
 *   Pg->>Adapter: raw(query, false)
 *   Adapter->>Mastra: listWorkflowRuns/listScoresByRunId/listTraces
 *   Mastra-->>Adapter: rows + total
 *   Adapter-->>Pg: projected model rows
 *   Pg-->>GW: page rows + serving metadata
 *   deactivate Pg
 *   GW-->>Caller: MastraMetricsPage
 *   deactivate GW
 */
import {
  Paginator,
  Repository,
  repository,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import { NotFoundError } from "@decaf-ts/db-decorators";
import {
  canAccessGraphResource,
  canAccessGraphResourcePayload,
} from "../engine/runs/ownership";
import {
  MastraRunMetricModel,
  MastraScoreMetricModel,
  MastraTraceMetricModel,
  type MastraMetricModel,
} from "./MastraMetricsModels";
import {
  MastraMetricsAdapter,
  MASTRA_METRICS_FLAVOUR,
} from "./MastraMetricsAdapter";
import { MastraMetricsStatement } from "./MastraMetricsStatement";

/** Default page size the gateway serves when the caller requests none. */
export const MASTRA_METRICS_PAGE_SIZE_DEFAULT = 20;
/** Maximum page size the gateway serves (calls asking for more are clamped). */
export const MASTRA_METRICS_PAGE_SIZE_MAX = 100;

/** A served metrics page: rows plus the paginator's serving metadata. */
export interface MastraMetricsPage<M extends MastraMetricModel> {
  /** The page's model rows (never nil: an empty result is an empty array, R7). */
  data: M[];
  /** One-indexed page number that was served. */
  current: number;
  /** Total pages the storage reported. */
  total: number;
  /** Total records the storage reported. */
  count: number;
  /** Bookmark of the last served row, when any. */
  bookmark?: string | number;
}

/**
 * The C23 ownership anchor the gateway scopes every read with. The backend
 * supplies it from the same catalogue map the mastra workflow lookups deny
 * through: a workflow unknown to the anchor resolves to `undefined`, and a
 * known workflow resolves to its recorded owner (absent for owner-less,
 * standalone workflows).
 */
export interface MastraMetricsOwnership {
  resolveWorkflow(
    workflowId: string
  ): { known: boolean; owner?: string } | undefined;
}

/**
 * Read-only repository for {@link MastraRunMetricModel} rows, bound to the
 * dedicated mastra metrics adapter flavour.
 */
@repository(MastraRunMetricModel, MASTRA_METRICS_FLAVOUR)
export class MastraRunMetricRepository extends Repository<
  MastraRunMetricModel,
  MastraMetricsAdapter
> {
  /**
   * Builds the repository over an adapter (or the flavour-registered default).
   *
   * @param adapter - The mastra metrics adapter, when not resolved from the registry.
   */
  constructor(adapter?: MastraMetricsAdapter) {
    super(adapter, MastraRunMetricModel);
  }
}

/**
 * Read-only repository for {@link MastraScoreMetricModel} rows, bound to the
 * dedicated mastra metrics adapter flavour.
 */
@repository(MastraScoreMetricModel, MASTRA_METRICS_FLAVOUR)
export class MastraScoreMetricRepository extends Repository<
  MastraScoreMetricModel,
  MastraMetricsAdapter
> {
  /**
   * Builds the repository over an adapter (or the flavour-registered default).
   *
   * @param adapter - The mastra metrics adapter, when not resolved from the registry.
   */
  constructor(adapter?: MastraMetricsAdapter) {
    super(adapter, MastraScoreMetricModel);
  }
}

/**
 * Read-only repository for {@link MastraTraceMetricModel} rows, bound to the
 * dedicated mastra metrics adapter flavour.
 */
@repository(MastraTraceMetricModel, MASTRA_METRICS_FLAVOUR)
export class MastraTraceMetricRepository extends Repository<
  MastraTraceMetricModel,
  MastraMetricsAdapter
> {
  /**
   * Builds the repository over an adapter (or the flavour-registered default).
   *
   * @param adapter - The mastra metrics adapter, when not resolved from the registry.
   */
  constructor(adapter?: MastraMetricsAdapter) {
    super(adapter, MastraTraceMetricModel);
  }
}

/**
 * Projects one metric row with the given sensitive payload members removed,
 * for callers that are not payload-authorized (SAA-93 F1 applied to mastra
 * score/trace rows). The projection preserves the row's class and every
 * non-payload member and deletes the payload keys outright, so a gated row
 * carries no payload member at all (fail-closed, not merely `undefined`).
 *
 * @param row - The metric row to project.
 * @param keys - The sensitive payload members to remove.
 * @returns A same-class clone of the row without the payload members.
 */
function withoutPayloadMembers<M extends MastraMetricModel>(
  row: M,
  ...keys: (keyof M & string)[]
): M {
  const projected = Object.create(Object.getPrototypeOf(row)) as M;
  Object.assign(projected, row);
  for (const key of keys) delete projected[key];
  return projected;
}

/**
 * Normalizes a caller-supplied page size: integers within `[1, MAX]` pass,
 * everything else degrades to the default page size.
 *
 * @param size - The requested page size.
 * @returns The normalized page size.
 */
function pageSizeOf(size: number | undefined): number {
  if (
    typeof size === "number" &&
    Number.isInteger(size) &&
    size >= 1 &&
    size <= MASTRA_METRICS_PAGE_SIZE_MAX
  ) {
    return size;
  }
  return MASTRA_METRICS_PAGE_SIZE_DEFAULT;
}

/**
 * Owner-scoped serving gateway for the read-only mastra metrics models
 * (SAA-836 S2). Every read is scoped to one canonical workflow: the workflow
 * must be known to the ownership anchor and accessible to the caller (C23
 * precedent — a foreign-owner or unknown workflow is denied with a constant
 * `NotFoundError` that maps to `404` and never carries details).
 */
export class MastraMetricsGateway {
  /** The read-only adapter the gateway serves every read through. */
  private readonly adapter: MastraMetricsAdapter;
  /** The read-only run rows repository. */
  private readonly runsRepository: MastraRunMetricRepository;
  /** The read-only score rows repository. */
  private readonly scoresRepository: MastraScoreMetricRepository;
  /** The read-only trace rows repository. */
  private readonly tracesRepository: MastraTraceMetricRepository;

  /**
   * Builds the gateway over the wired mastra runtime and ownership anchor.
   *
   * @param options - The wired mastra runtime, the C23 ownership anchor, and an optional adapter alias.
   */
  constructor(
    private readonly options: {
      mastra: unknown;
      ownership: MastraMetricsOwnership;
      alias?: string;
    }
  ) {
    this.adapter = new MastraMetricsAdapter(
      { mastra: options.mastra },
      options.alias
    );
    // Resolved through `Repository.forModel` (the verified `RamGraphRunStore`
    // pattern) instead of direct construction: the `@repository` decorator
    // wraps each class in an injectable proxy whose `new` resolves through the
    // injectables registry, so a direct construction can yield a hollow
    // instance. `forModel` builds from the registered raw class with the
    // adapter bound, so `read()` always has its adapter.
    this.runsRepository = Repository.forModel(
      MastraRunMetricModel,
      this.adapter.alias
    ) as unknown as MastraRunMetricRepository;
    this.scoresRepository = Repository.forModel(
      MastraScoreMetricModel,
      this.adapter.alias
    ) as unknown as MastraScoreMetricRepository;
    this.tracesRepository = Repository.forModel(
      MastraTraceMetricModel,
      this.adapter.alias
    ) as unknown as MastraTraceMetricRepository;
  }

  /**
   * Resolves and access-checks the canonical workflow for a metrics read.
   * Unknown and foreign-owner workflows both deny with a constant
   * `NotFoundError` (C23), so a caller cannot probe another owner's workflow ids.
   *
   * @param workflowId - The canonical workflow id being accessed.
   * @param callerOwner - The authenticated caller, or `null`/`undefined` for anonymous.
   * @returns The resolved owner (absent for owner-less, standalone workflows).
   * @throws {NotFoundError} when the workflow is unknown or foreign to the caller.
   */
  private accessibleOwnerOf(
    workflowId: string,
    callerOwner: string | null | undefined
  ): string | undefined {
    const resolved = this.options.ownership.resolveWorkflow(workflowId);
    if (!resolved || !resolved.known) {
      throw new NotFoundError(
        `No graph workflow found for workflowId '${workflowId}'`
      );
    }
    if (!canAccessGraphResource({ owner: resolved.owner }, callerOwner)) {
      throw new NotFoundError(
        `No graph workflow found for workflowId '${workflowId}'`
      );
    }
    return resolved.owner;
  }

  /**
   * Resolves the run row for a score/trace read and verifies it belongs to the
   * accessed workflow, so a caller cannot read another workflow's runs by id.
   *
   * @param workflowId - The canonical workflow id the run must belong to.
   * @param runId - The mastra run id being accessed.
   * @throws {NotFoundError} when the run is absent or belongs to another workflow.
   */
  private async assertRunOfWorkflow(
    workflowId: string,
    runId: string
  ): Promise<void> {
    const row = await this.tryReadRun(runId);
    if (!row || row.workflowId !== workflowId) {
      throw new NotFoundError(`No graph run found for runId '${runId}'`);
    }
  }

  /**
   * Best-effort single run read: any storage failure (absent run, unavailable
   * domain) degrades to `undefined` so callers deny with a constant `NotFoundError`.
   *
   * @param runId - The mastra run id to read.
   * @param args - Optional decaf contextual arguments forwarded to the storage.
   * @returns The run metric row, or `undefined` when it cannot be read.
   */
  private async tryReadRun(
    runId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<MastraRunMetricModel | undefined> {
    try {
      return (await this.runsRepository.read(
        runId,
        ...args
      )) as MastraRunMetricModel;
    } catch {
      return undefined;
    }
  }

  /**
   * Executes a paged read through the statement/paginator over the adapter.
   *
   * @param statement - The scoped statement to execute.
   * @param page - One-indexed page number (defaults to 1).
   * @param perPage - Requested page size (clamped to the documented maximum).
   * @param args - Optional decaf contextual arguments forwarded to the storage.
   * @returns The served page with rows and serving metadata.
   */
  private async pageOf<M extends MastraMetricModel>(
    statement: MastraMetricsStatement<M>,
    page: number | undefined,
    perPage: number | undefined,
    ...args: MaybeContextualArg<Context>
  ): Promise<MastraMetricsPage<M>> {
    const size = pageSizeOf(perPage);
    const paginator: Paginator<M, M[], any> = await statement.paginate(
      size,
      ...args
    );
    const rows = await paginator.page(page ?? 1, ...(args as never[]));
    const bookmark = paginator["_bookmark"] as string | number | undefined;
    return {
      data: rows,
      current: paginator.current,
      total: paginator.total,
      count: paginator.count,
      ...(bookmark !== undefined ? { bookmark } : {}),
    };
  }

  /**
   * Serves one page of the workflow's mastra run metrics (newest first as
   * mastra returns them).
   *
   * @param workflowId - The canonical workflow id whose runs are served.
   * @param callerOwner - The authenticated caller, or `null` for anonymous.
   * @param page - One-indexed page number (defaults to 1).
   * @param perPage - Requested page size (clamped to the documented maximum).
   * @param args - Optional decaf contextual arguments forwarded to the storage.
   * @throws {NotFoundError} when the workflow is unknown or foreign to the caller.
   */
  async listRuns(
    workflowId: string,
    callerOwner: string | null | undefined,
    page?: number,
    perPage?: number,
    ...args: MaybeContextualArg<Context>
  ): Promise<MastraMetricsPage<MastraRunMetricModel>> {
    this.accessibleOwnerOf(workflowId, callerOwner);
    const statement = this.adapter
      .Statement<MastraRunMetricModel>()
      .forWorkflow(workflowId);
    return this.pageOf(
      statement.from(MastraRunMetricModel) as MastraMetricsStatement<MastraRunMetricModel>,
      page,
      perPage,
      ...args
    );
  }

  /**
   * Reads one mastra run metric of the workflow.
   *
   * @param workflowId - The canonical workflow id the run must belong to.
   * @param runId - The mastra run id to read.
   * @param callerOwner - The authenticated caller, or `null` for anonymous.
   * @param args - Optional decaf contextual arguments forwarded to the storage.
   * @returns The run metric row.
   * @throws {NotFoundError} when the workflow is unknown/foreign, or the run is absent or belongs to another workflow.
   */
  async getRun(
    workflowId: string,
    runId: string,
    callerOwner: string | null | undefined,
    ...args: MaybeContextualArg<Context>
  ): Promise<MastraRunMetricModel> {
    this.accessibleOwnerOf(workflowId, callerOwner);
    const row = await this.tryReadRun(runId, ...args);
    if (!row || row.workflowId !== workflowId) {
      throw new NotFoundError(`No graph run found for runId '${runId}'`);
    }
    return row;
  }

  /**
   * Serves one page of the run's mastra score metrics. The run must belong to
   * the accessed workflow, so scores of another workflow's runs are denied.
   *
   * @param workflowId - The canonical workflow id whose run is served.
   * @param runId - The mastra run id the scores were recorded for.
   * @param callerOwner - The authenticated caller, or `null` for anonymous.
   * @param page - One-indexed page number (defaults to 1).
   * @param perPage - Requested page size (clamped to the documented maximum).
   * @param args - Optional decaf contextual arguments forwarded to the storage.
   * @throws {NotFoundError} when the workflow or run is unknown/foreign (C23 deny).
   */
  async listScores(
    workflowId: string,
    runId: string,
    callerOwner: string | null | undefined,
    page?: number,
    perPage?: number,
    ...args: MaybeContextualArg<Context>
  ): Promise<MastraMetricsPage<MastraScoreMetricModel>> {
    const owner = this.accessibleOwnerOf(workflowId, callerOwner);
    await this.assertRunOfWorkflow(workflowId, runId);
    const statement = this.adapter
      .Statement<MastraScoreMetricModel>()
      .forWorkflow(workflowId)
      .forRun(runId);
    const served = await this.pageOf(
      statement.from(MastraScoreMetricModel) as MastraMetricsStatement<MastraScoreMetricModel>,
      page,
      perPage,
      ...args
    );
    if (!canAccessGraphResourcePayload({ owner }, callerOwner)) {
      return {
        ...served,
        data: served.data.map((row) =>
          withoutPayloadMembers(row, "input", "output")
        ),
      };
    }
    return served;
  }

  /**
   * Serves one page of the run's mastra trace metric spans. The run must
   * belong to the accessed workflow, so spans of another workflow's runs are
   * denied.
   *
   * @param workflowId - The canonical workflow id whose run is served.
   * @param runId - The mastra run id the spans were recorded for.
   * @param callerOwner - The authenticated caller, or `null` for anonymous.
   * @param page - One-indexed page number (defaults to 1).
   * @param perPage - Requested page size (clamped to the documented maximum).
   * @param args - Optional decaf contextual arguments forwarded to the storage.
   * @throws {NotFoundError} when the workflow or run is unknown/foreign (C23 deny).
   */
  async listTraces(
    workflowId: string,
    runId: string,
    callerOwner: string | null | undefined,
    page?: number,
    perPage?: number,
    ...args: MaybeContextualArg<Context>
  ): Promise<MastraMetricsPage<MastraTraceMetricModel>> {
    const owner = this.accessibleOwnerOf(workflowId, callerOwner);
    await this.assertRunOfWorkflow(workflowId, runId);
    const statement = this.adapter
      .Statement<MastraTraceMetricModel>()
      .forWorkflow(workflowId)
      .forRun(runId);
    const served = await this.pageOf(
      statement.from(MastraTraceMetricModel) as MastraMetricsStatement<MastraTraceMetricModel>,
      page,
      perPage,
      ...args
    );
    if (!canAccessGraphResourcePayload({ owner }, callerOwner)) {
      return {
        ...served,
        data: served.data.map((row) => withoutPayloadMembers(row, "summary")),
      };
    }
    return served;
  }

  /**
   * Whether the canonical workflow is known to the ownership anchor (that is,
   * it is a mastra-owned catalogue workflow). Unknown workflows are not
   * mastra-served, so the endpoint delegation falls back to local rows.
   *
   * @param workflowId - The canonical workflow id to look up.
   * @returns `true` when the workflow is known to the ownership anchor.
   */
  knowsWorkflowOf(workflowId: string): boolean {
    const resolved = this.options.ownership.resolveWorkflow(workflowId);
    return !!resolved && resolved.known;
  }

  /**
   * The recorded owner of a known canonical workflow (absent for owner-less,
   * standalone workflows). Unknown workflows resolve to `undefined`.
   *
   * @param workflowId - The canonical workflow id to look up.
   * @returns The recorded owner, or `undefined` when unknown or owner-less.
   */
  ownerOf(workflowId: string): string | undefined {
    const resolved = this.options.ownership.resolveWorkflow(workflowId);
    if (!resolved || !resolved.known) return undefined;
    return resolved.owner;
  }

  /**
   * Whether the caller may see a workflow's sensitive metric payload members
   * (run snapshots, score inputs/outputs, span summaries): the same
   * payload-scoped predicate the graph run rows serve under (SAA-93 F1
   * contract applied to mastra metric rows).
   *
   * @param workflowId - The canonical workflow id to look up.
   * @param callerOwner - The requesting principal's owner, when known.
   * @returns Whether the caller may see the workflow's metric payload.
   */
  payloadVisibleOf(
    workflowId: string,
    callerOwner: string | null | undefined
  ): boolean {
    const resolved = this.options.ownership.resolveWorkflow(workflowId);
    if (!resolved || !resolved.known) return false;
    return canAccessGraphResourcePayload(
      { owner: resolved.owner },
      callerOwner
    );
  }
}
