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
    ...(run.workerId ? { workerId: run.workerId } : {}),
    ...(run.heartbeatAt ? { heartbeatAt: new Date(run.heartbeatAt) } : {}),
    ...(run.suspendedAt ? { suspendedAt: new Date(run.suspendedAt) } : {}),
    ...(run.attempt !== undefined ? { attempt: run.attempt } : {}),
    ...(run.callerKey ? { callerKey: run.callerKey } : {}),
    ...(run.idempotencyKey ? { idempotencyKey: run.idempotencyKey } : {}),
    ...(run.requestHash ? { requestHash: run.requestHash } : {}),
    ...(run.storedBytes !== undefined ? { storedBytes: run.storedBytes } : {}),
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
    ...(model.workerId ? { workerId: model.workerId } : {}),
    ...(model.heartbeatAt ? { heartbeatAt: new Date(model.heartbeatAt).toISOString() } : {}),
    ...(model.suspendedAt ? { suspendedAt: new Date(model.suspendedAt).toISOString() } : {}),
    ...(model.attempt !== undefined && model.attempt !== null ? { attempt: Number(model.attempt) } : {}),
    ...(model.callerKey ? { callerKey: model.callerKey } : {}),
    ...(model.idempotencyKey ? { idempotencyKey: model.idempotencyKey } : {}),
    ...(model.requestHash ? { requestHash: model.requestHash } : {}),
    ...(model.storedBytes !== undefined && model.storedBytes !== null
      ? { storedBytes: Number(model.storedBytes) }
      : {}),
  };
}

function toJsonSafe(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * Milliseconds of a run timestamp as stores return it: a `Date`, an ISO
 * string, or the Decaf formatted date (`dd-MM-yyyy HH:mm:ss:SSS`, also with
 * `/`). `NaN` when unreadable.
 *
 * @param value - The timestamp.
 */
export function graphRunTimeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const decaf = /^(\d{2})[-/](\d{2})[-/](\d{4})[ T](\d{2}):(\d{2}):(\d{2})(?::(\d{1,3}))?$/.exec(
    value.trim()
  );
  if (decaf) {
    const [, day, month, year, hour, minute, second, ms] = decaf;
    // Decaf formats with the local-time getters.
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number((ms ?? "0").padEnd(3, "0"))
    ).getTime();
  }
  return Date.parse(value);
}
