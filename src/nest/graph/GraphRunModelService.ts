/**
 * @module as-graph/nest/graph/GraphRunModelService
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
import type {
  GraphRun,
  GraphRunStore,
} from "../../engine/runs/types";
import { isGraphRunStatus } from "../../shared/graph";
import { GraphRunModel } from "./GraphRunModel";

function toJsonSafe(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function runToModel(run: GraphRun): GraphRunModel {
  return new GraphRunModel({
    runId: run.runId,
    workflowId: run.workflowId,
    ...(run.ownerUser ? { owner: run.ownerUser } : {}),
    status: run.status,
    ...(run.documentFingerprint
      ? { documentFingerprint: run.documentFingerprint }
      : {}),
    ...(run.result !== undefined
      ? { result: toJsonSafe(run.result) as Record<string, unknown> }
      : {}),
    ...(run.error ? { error: toJsonSafe(run.error) } : {}),
    createdAt: new Date(run.createdAt),
    ...(run.startedAt ? { startedAt: new Date(run.startedAt) } : {}),
    ...(run.finishedAt ? { finishedAt: new Date(run.finishedAt) } : {}),
  });
}

function modelToRun(model: GraphRunModel): GraphRun {
  const result = model.result as GraphRun["result"];
  return {
    runId: model.runId,
    workflowId: model.workflowId,
    ownerUser: model.owner ?? null,
    status: isGraphRunStatus(model.status) ? model.status : "failed",
    createdAt: model.createdAt.toISOString(),
    ...(model.startedAt ? { startedAt: model.startedAt.toISOString() } : {}),
    ...(model.finishedAt ? { finishedAt: model.finishedAt.toISOString() } : {}),
    ...(result ? { result } : {}),
    ...(model.error
      ? { error: model.error as unknown as GraphRun["error"] }
      : {}),
    ...(model.documentFingerprint
      ? { documentFingerprint: model.documentFingerprint }
      : {}),
  };
}

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
}
