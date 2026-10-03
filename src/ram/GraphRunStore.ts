/**
 * @module as-graph/ram/GraphRunStore
 * @summary Adapter-backed graph run store (DECAF-50 §4.14).
 * @description Repository-backed {@link GraphRunStore} that persists runs as
 * {@link GraphRunModel} rows through a provided Decaf adapter (RamAdapter in
 * tests, a durable adapter in production).
 */
import {
  Repository,
  repository,
  type Adapter,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import { DefaultFlavour } from "@decaf-ts/decoration";
import type { GraphRun, GraphRunStore } from "../engine/runs/types";
import { GraphRunModel } from "../shared/graph";
import {
  modelToRun,
  runToModel,
} from "../engine/runs/GraphRunConverters";

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
      existing.workflowId = model.workflowId;
      existing.owner = model.owner;
      existing.status = model.status;
      existing.documentFingerprint = model.documentFingerprint;
      existing.result = model.result;
      existing.error = model.error;
      existing.startedAt = model.startedAt;
      existing.finishedAt = model.finishedAt;
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
}
