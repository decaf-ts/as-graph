/**
 * @module as-graph/engine/services/GraphRunModelService
 * @summary Persistent run store on the Decaf model layer.
 * @description Persists {@link GraphRun} rows as {@link GraphRunModel} via
 * the Decaf {@link ModelService}, implementing the engine-side
 * {@link GraphRunStore} and converting between the engine run shape and the
 * JSON-safe persisted columns.
 */
import {
  ModelService,
  service,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import type { GraphRun, GraphRunStore } from "../runs/types";
import { GraphRunModel } from "../../shared/graph";
import { modelToRun, runToModel } from "../runs/GraphRunConverters";

/**
 * Model-backed {@link GraphRunStore}: persists runs as {@link GraphRunModel}
 * rows via the Decaf ModelService, converting between the engine-side
 * {@link GraphRun} shape and the JSON-safe persisted columns.
 */
@service(GraphRunModel)
export class GraphRunModelService extends ModelService<GraphRunModel>
  implements GraphRunStore {
  constructor() {
    super(GraphRunModel);
  }

  /**
   * Upserts a run row: updates the JSON-safe columns when a row for
   * `run.runId` already exists, otherwise creates a new row from the
   * engine-side run shape.
   *
   * @param {GraphRun} run - Engine-side run to persist.
   * @param args - An optional decaf `Context` forwarded to the model service.
   * @return {Promise<void>} Resolves when the run row is persisted.
   */
  async saveRun(
    run: GraphRun,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    const { ctxArgs } = (await this.logCtx(args, "saveRun", true)).for(
      this.saveRun
    );
    const model = runToModel(run);
    let existing: GraphRunModel | null;
    try {
      existing = (await super.read(run.runId, ...ctxArgs)) as GraphRunModel;
    } catch {
      existing = null;
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
      await this.update(existing, ...ctxArgs);
      return;
    }
    await this.create(model, ...ctxArgs);
  }

  /**
   * Reads a run row and converts it back to the engine-side run shape.
   *
   * @param {string} runId - Id of the run to read.
   * @param args - An optional decaf `Context` forwarded to the model service.
   * @return {Promise<GraphRun | null>} The run, or `null` when no row exists.
   */
  async readRun(
    runId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun | null> {
    const { ctxArgs } = (await this.logCtx(args, "readRun", true)).for(
      this.readRun
    );
    try {
      const model = (await super.read(runId, ...ctxArgs)) as GraphRunModel;
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
   * @param args - An optional decaf `Context` forwarded to the model service.
   * @return {Promise<GraphRunModel[]>} The matching rows (empty when none exist).
   */
  async listRuns(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRunModel[]> {
    const { ctxArgs } = (await this.logCtx(args, "listRuns", true)).for(
      this.listRuns
    );
    try {
      return (await this.findBy(
        "workflowId",
        workflowId,
        ...ctxArgs
      )) as GraphRunModel[];
    } catch {
      return [];
    }
  }
}
