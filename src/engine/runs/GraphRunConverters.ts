/**
 * @module as-graph/engine/runs/GraphRunConverters
 * @summary Engine-side conversion between {@link GraphRun} and {@link GraphRunModel}.
 * @description The shared {@link GraphRunModel} row is a frontend-safe
 * `persistedModelClass`; the engine {@link GraphRun} carries engine-only result
 * and error payloads. These helpers convert between the two so the persistence
 * stores and the run model service share a single model definition.
 */
import { isGraphRunStatus } from "../../shared/graph";
import { GraphRunModel } from "../../shared/graph";
import type { GraphRun } from "./types";

/** Converts an engine-side {@link GraphRun} into its persistable model row. */
export function runToModel(run: GraphRun): GraphRunModel {
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

/** Converts a persisted model row back into the engine-side {@link GraphRun}. */
export function modelToRun(model: GraphRunModel): GraphRun {
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
    ...(model.error ? { error: model.error as unknown as GraphRun["error"] } : {}),
    ...(model.documentFingerprint
      ? { documentFingerprint: model.documentFingerprint }
      : {}),
  };
}

function toJsonSafe(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
