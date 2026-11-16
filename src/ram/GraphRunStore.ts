/**
 * @module as-graph/ram/GraphRunStore
 * @summary Adapter-backed graph run store (DECAF-50 §4.14).
 * @description Repository-backed {@link GraphRunStore} that persists runs as
 * {@link GraphRunModel} rows through a provided Decaf adapter (RamAdapter in
 * tests, a durable adapter in production).
 */
import {
  Condition,
  OrderDirection,
  Repository,
  repository,
  type Adapter,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import { DefaultFlavour } from "@decaf-ts/decoration";
import {
  GRAPH_RUN_ACTIVE_STATUSES,
  GRAPH_RUN_FINISHED_STATUSES,
  type GraphRun,
  type GraphRunPruneQuery,
  type GraphRunRetentionEntry,
  type GraphRunStore,
} from "../engine/runs/types";
import { GraphRunModel } from "../shared/graph";
import {
  modelToRun,
  runToModel,
} from "../engine/runs/GraphRunConverters";

/**
 * Explicit ceiling for counting/listing queries (the Postgres adapter
 * otherwise applies a default page of 250 rows).
 */
const QUERY_CEILING = 100_000;

/** Columns `saveRun` copies onto an existing row. */
const RUN_COLUMNS = [
  "workflowId",
  "owner",
  "status",
  "documentFingerprint",
  "result",
  "error",
  "startedAt",
  "finishedAt",
  "workerId",
  "heartbeatAt",
  "suspendedAt",
  "attempt",
  "callerKey",
  "idempotencyKey",
  "requestHash",
  "storedBytes",
] as const;

/** Repository for {@link GraphRunModel} rows. */
@repository(GraphRunModel, DefaultFlavour)
export class GraphRunRepository extends Repository<
  GraphRunModel,
  Adapter<any, any, any, any>
> {
  constructor(adapter?: Adapter<any, any, any, any>) {
    super(adapter, GraphRunModel);
  }
}

/**
 * Adapter-backed {@link GraphRunStore}. Requires a provided adapter; the caller
 * owns adapter initialization and lifecycle.
 */
export class RamGraphRunStore implements GraphRunStore {
  private readonly repo: GraphRunRepository;

  constructor(adapter: Adapter<any, any, any, any>) {
    this.repo = Repository.forModel(
      GraphRunModel,
      adapter.alias
    ) as GraphRunRepository;
  }

  /**
   * Upserts a run row against the configured adapter: updates the JSON-safe
   * columns when a row for `run.runId` exists, otherwise creates it.
   *
   * @param {GraphRun} run - Engine-side run to persist.
   * @param args - Optional decaf `Context` arguments forwarded to the repository.
   * @return {Promise<void>} Resolves when the run row is persisted.
   */
  async saveRun(
    run: GraphRun,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    const model = runToModel(run);
    let existing: GraphRunModel | undefined;
    try {
      existing = (await this.repo.read(run.runId, ...args)) as GraphRunModel;
    } catch {
      existing = undefined;
    }
    if (existing) {
      // Every column follows the run; a field the run no longer carries
      // (e.g. `suspendedAt` after a resume) is cleared.
      for (const key of RUN_COLUMNS) {
        const value = (model as unknown as Record<string, unknown>)[key];
        (existing as unknown as Record<string, unknown>)[key] =
          value === undefined ? null : value;
      }
      await this.repo.update(existing, ...args);
      return;
    }
    await this.repo.create(model, ...args);
  }

  /**
   * Reads a run row and converts it back to the engine-side run shape.
   *
   * @param {string} runId - Id of the run to read.
   * @param args - Optional decaf `Context` arguments forwarded to the repository.
   * @return {Promise<GraphRun | null>} The run, or `null` when no row exists.
   */
  async readRun(
    runId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun | null> {
    try {
      const model = (await this.repo.read(runId, ...args)) as GraphRunModel;
      return modelToRun(model);
    } catch {
      return null;
    }
  }

  /**
   * Lists every persisted run row for the given workflow document as its
   * persisted {@link GraphRunModel} shape (keeping storage-derived fields such
   * as `updatedAt` and `inputs`).
   *
   * @param {string} workflowId - Workflow document id the runs executed.
   * @param args - Optional decaf `Context` arguments forwarded to the repository.
   * @return {Promise<GraphRunModel[]>} The matching rows — empty only when no
   * runs exist for the workflow. A store failure now propagates to the caller
   * instead of being swallowed into an empty list (SAA-93 R1).
   */
  async listRuns(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRunModel[]> {
    return (await this.repo.findBy(
      "workflowId",
      workflowId,
      ...args
    )) as GraphRunModel[];
  }

  /**
   * One batch of prunable finished runs — an indexed query on
   * `(status, finishedAt)`: finished before `before` oldest first, or the
   * finished runs after the newest `keepNewest`.
   *
   * @param query - Age or count query, with the batch size.
   * @param args - Optional decaf `Context` arguments forwarded to the repository.
   * @return {Promise<GraphRunRetentionEntry[]>} The batch.
   */
  async listPrunableRuns(
    query: GraphRunPruneQuery,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRunRetentionEntry[]> {
    const finished = Condition.attr<GraphRunModel>("status").in([
      ...GRAPH_RUN_FINISHED_STATUSES,
    ]);
    const models = (
      query.before !== undefined
        ? await this.repo
            .select()
            .where(
              finished.and(
                Condition.attr<GraphRunModel>("finishedAt").lt(query.before)
              )
            )
            .orderBy("finishedAt", OrderDirection.ASC)
            .limit(query.limit)
            .execute(...args)
        : await this.beyondNewest(query.keepNewest ?? 0, query.limit, ...args)
    ) as GraphRunModel[];
    return models.map((model) => ({
      runId: model.runId,
      status: model.status,
      ...(model.createdAt ? { createdAt: new Date(model.createdAt) } : {}),
      ...(model.finishedAt ? { finishedAt: new Date(model.finishedAt) } : {}),
    }));
  }

  /**
   * Deletes a run row (no-op for an unknown id).
   *
   * @param {string} runId - Id of the run to delete.
   * @param args - Optional decaf `Context` arguments forwarded to the repository.
   * @return {Promise<void>} Resolves once the row is gone.
   */
  async deleteRun(
    runId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    try {
      await this.repo.delete(runId, ...args);
    } catch {
      // deleting a run that is already gone is a no-op
    }
  }

  /**
   * Finished runs older than the newest `keep`, via a boundary instead of an
   * offset: the `keep`-th newest finish time (a light projection), then the
   * age query below it.
   */
  private async beyondNewest(
    keep: number,
    limit: number,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRunModel[]> {
    const finished = Condition.attr<GraphRunModel>("status").in([
      ...GRAPH_RUN_FINISHED_STATUSES,
    ]);
    if (keep <= 0) {
      return (await this.repo
        .select()
        .where(finished)
        .orderBy("finishedAt", OrderDirection.ASC)
        .limit(limit)
        .execute(...args)) as GraphRunModel[];
    }
    const newest = (await this.repo
      .select(["runId", "finishedAt"] as never)
      .where(finished)
      .orderBy("finishedAt", OrderDirection.DSC)
      .limit(keep)
      .execute(...args)) as GraphRunModel[];
    if (newest.length < keep) return [];
    const boundary = newest[newest.length - 1].finishedAt;
    if (!boundary) return [];
    return (await this.repo
      .select()
      .where(
        finished.and(Condition.attr<GraphRunModel>("finishedAt").lt(boundary))
      )
      .orderBy("finishedAt", OrderDirection.ASC)
      .limit(limit)
      .execute(...args)) as GraphRunModel[];
  }

  /** Unfinished runs (bounded by concurrency, so the status index is selective). */
  private async activeRuns(
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRunModel[]> {
    return (await this.repo
      .select()
      .where(
        Condition.attr<GraphRunModel>("status").in([...GRAPH_RUN_ACTIVE_STATUSES])
      )
      .limit(QUERY_CEILING)
      .execute(...args)) as GraphRunModel[];
  }

  async listStaleRuns(
    query: { before: Date; includeQueued: boolean },
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun[]> {
    const before = query.before.getTime();
    return (await this.activeRuns(...args))
      .filter((model) => query.includeQueued || model.status !== "queued")
      .filter((model) => !model.suspendedAt)
      .filter((model) => {
        const beat = model.heartbeatAt ?? model.startedAt ?? model.createdAt;
        return beat !== undefined && new Date(beat).getTime() < before;
      })
      .map((model) => modelToRun(model));
  }

  async heartbeat(
    runId: string,
    workerId: string,
    at: Date,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    try {
      const existing = (await this.repo.read(runId, ...args)) as GraphRunModel;
      existing.workerId = workerId;
      existing.heartbeatAt = at;
      await this.repo.update(existing, ...args);
    } catch {
      // a run deleted mid-execution has nothing to beat for
    }
  }

  async countActiveRuns(
    callerKey: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<number> {
    const models = (await this.repo
      .select()
      .where(
        Condition.attr<GraphRunModel>("callerKey")
          .eq(callerKey)
          .and(
            Condition.attr<GraphRunModel>("status").in([...GRAPH_RUN_ACTIVE_STATUSES])
          )
      )
      .limit(QUERY_CEILING)
      .execute(...args)) as GraphRunModel[];
    return models.length;
  }

  async countRunsSince(
    callerKey: string,
    since: Date,
    ...args: MaybeContextualArg<Context>
  ): Promise<number> {
    const models = (await this.repo
      .select()
      .where(
        Condition.attr<GraphRunModel>("callerKey")
          .eq(callerKey)
          .and(Condition.attr<GraphRunModel>("createdAt").gte(since))
      )
      .limit(QUERY_CEILING)
      .execute(...args)) as GraphRunModel[];
    return models.length;
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun | null> {
    const models = (await this.repo
      .select()
      .where(Condition.attr<GraphRunModel>("idempotencyKey").eq(idempotencyKey))
      .limit(1)
      .execute(...args)) as GraphRunModel[];
    return models[0] ? modelToRun(models[0]) : null;
  }

  async sumStoredBytes(
    callerKey: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<number> {
    const models = (await this.repo
      .select(["storedBytes"] as never)
      .where(Condition.attr<GraphRunModel>("callerKey").eq(callerKey))
      .limit(QUERY_CEILING)
      .execute(...args)) as GraphRunModel[];
    return models.reduce((total, model) => total + Number(model.storedBytes ?? 0), 0);
  }
}
