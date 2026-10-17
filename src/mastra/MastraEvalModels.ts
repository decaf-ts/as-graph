/**
 * @module as-graph/mastra/MastraEvalModels
 * @summary Read-only mastra eval models (SAA-836 O1, extends S2).
 * @description Persistable, frontend-safe projections of the mastra storage
 * eval data (experiments and their per-item results — mastra's eval surface in
 * the current `@mastra/core` storage). The models follow the S2
 * {@link module:as-graph/mastra/MastraMetricsModels} pattern exactly: every
 * surface below serves reads only, rows are JSON-safe (the converters sanitize
 * every payload member before a model is built), and a row that cannot be
 * projected is skipped, never fabricated (R7: nil rows never).
 *
 * The module exports the two read-only eval models
 * ({@link MastraEvalExperimentModel}, {@link MastraEvalResultModel}), the raw
 * mastra storage row shapes they project from, and the row-to-model converters
 * the read serving path consumes.
 */
import {
  date,
  model,
  required,
  type,
} from "@decaf-ts/decorator-validation";
import { description, prop } from "@decaf-ts/decoration";
import { BaseModel, column, index, pk, table } from "@decaf-ts/core";
import {
  uielement,
  uilistmodel,
  uilistprop,
  uimodel,
} from "@decaf-ts/ui-decorators";

// Reuses the repo's JSON-safe gating helpers so a non-JSON-safe mastra payload
// member is dropped instead of leaking an unserializable value to the UI.
import {
  cloneGraphJsonValue,
  isGraphJsonSafeValue,
  type GraphJsonValue,
} from "../shared/graph/document/GraphJsonValue";

/** Fallback status for a mastra experiment row that exposes none. */
export const MASTRA_EVAL_STATUS_UNKNOWN = "unknown";

/** Fallback status for a mastra experiment-result row that exposes none. */
export const MASTRA_EVAL_RESULT_STATUS_UNKNOWN = "unknown";

/**
 * Clones an unknown mastra payload value into its JSON-safe projection, or
 * `undefined` when the value is absent or not JSON-safe. Unlike the S2 payload
 * helper (objects only), eval inputs/outputs/ground truths are arbitrary JSON
 * values, so arrays and primitives are preserved when JSON-safe.
 *
 * @param value - The raw mastra payload value (any shape).
 * @returns A JSON-safe clone of the value, or `undefined` when it is absent or not JSON-safe.
 */
function jsonSafeValueOrNull(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (!isGraphJsonSafeValue(value)) return undefined;
  return cloneGraphJsonValue(value as GraphJsonValue);
}

/**
 * Extracts a string member from an unknown mastra row value: a non-empty
 * string is kept, everything else (including `null`, which mastra uses for
 * "absent") degrades to `undefined`.
 *
 * @param value - The raw mastra row member.
 * @returns The string value, or `undefined` when it is absent or not a non-empty string.
 */
function stringOrNull(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Extracts a non-negative integer count from an unknown mastra row value,
 * degrading to the supplied default when the value is not a finite number.
 *
 * @param value - The raw mastra row member.
 * @param fallback - The value to serve when the member is not a finite number.
 * @returns The non-negative integer count.
 */
function countOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

/**
 * Extracts a JSON-safe string-array member (mastra `scorerIds` / `tags`),
 * degrading to `undefined` when the member is absent or not an array of
 * strings.
 *
 * @param value - The raw mastra row member.
 * @returns The string array, or `undefined` when it is not a string array.
 */
function stringArrayOrNull(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((member) => typeof member === "string")) return undefined;
  return value as string[];
}

/**
 * Converts a mastra storage date (`Date` | `string` | `number` | `undefined`)
 * to a `Date`, or `undefined` when the value cannot be a valid date.
 *
 * @param value - The raw mastra storage date value.
 * @returns The parsed `Date`, or `undefined` when the value is not a parseable date.
 */
function toDateOrNull(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Read-only mastra eval experiment row (SAA-836 O1, extends S2).
 *
 * One row per mastra storage experiment — the eval run mastra records when a
 * dataset is executed against a target (agent, workflow, scorer, or
 * processor). `experimentId` is the mastra storage experiment id, and the
 * counters/status carry the eval run's lifecycle exactly as mastra recorded
 * them.
 */
@uilistmodel("ngx-decaf-list-item", { icon: "ti-flask" })
@uimodel("ngx-decaf-crud-form")
@description("Read-only mastra eval experiment row")
@table("mastra_eval_experiment")
@model()
export class MastraEvalExperimentModel extends BaseModel {
  /** Mastra storage experiment id (not generated: mastra owns it). */
  @pk({ type: String, generated: false })
  @description("Mastra storage experiment id")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.experimentId.label",
    readonly: true,
  })
  experimentId!: string;

  /** Experiment name mastra recorded, when present. */
  @column()
  @description("Experiment name mastra recorded, when present")
  @uilistprop("name")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.name.label",
    readonly: true,
  })
  name?: string;

  /** Experiment description mastra recorded, when present. */
  @column()
  @description("Experiment description mastra recorded, when present")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.description.label",
    readonly: true,
  })
  description?: string;

  /** Mastra dataset the experiment ran, when dataset-backed. */
  @column()
  @index()
  @description("Mastra dataset the experiment ran, when dataset-backed")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.datasetId.label",
    readonly: true,
  })
  datasetId?: string;

  /** Mastra dataset version the experiment pinned, when dataset-backed. */
  @column()
  @type(Number)
  @description("Mastra dataset version the experiment pinned, when dataset-backed")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.datasetVersion.label",
    readonly: true,
  })
  datasetVersion?: number;

  /** Kind of executor the experiment ran against (`agent`/`workflow`/`scorer`/`processor`), when mastra executed the items. */
  @column()
  @description("Kind of executor the experiment ran against, when mastra executed the items")
  @uilistprop("targetType")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.targetType.label",
    readonly: true,
  })
  targetType?: string;

  /** Mastra id of the executor the experiment ran against, when mastra executed the items. */
  @column()
  @index()
  @description("Mastra id of the executor the experiment ran against, when mastra executed the items")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.targetId.label",
    readonly: true,
  })
  targetId?: string;

  /** Scorer ids pinned at experiment create time, when any. */
  @column()
  @description("Scorer ids pinned at experiment create time, when any")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.scorerIds.label",
    readonly: true,
  })
  scorerIds?: string[];

  /**
   * Experiment lifecycle status (required, never null): mastra's recorded
   * status, degrading to {@link MASTRA_EVAL_STATUS_UNKNOWN} when the row
   * exposes none.
   */
  @column()
  @required()
  @type(String)
  @index()
  @description("Experiment lifecycle status")
  @uilistprop("status")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.status.label",
    readonly: true,
  })
  status!: string;

  /** Total dataset items the experiment planned to run. */
  @column()
  @required()
  @type(Number)
  @description("Total dataset items the experiment planned to run")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.totalItems.label",
    readonly: true,
  })
  totalItems!: number;

  /** Items that succeeded. */
  @column()
  @required()
  @type(Number)
  @description("Items that succeeded")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.succeededCount.label",
    readonly: true,
  })
  succeededCount!: number;

  /** Items that failed. */
  @column()
  @required()
  @type(Number)
  @description("Items that failed")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.failedCount.label",
    readonly: true,
  })
  failedCount!: number;

  /** Items that were skipped. */
  @column()
  @required()
  @type(Number)
  @description("Items that were skipped")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.experiment.skippedCount.label",
    readonly: true,
  })
  skippedCount!: number;

  /** Experiment start timestamp, once started. */
  @date()
  @column()
  @description("Experiment start timestamp, once started")
  startedAt?: Date;

  /** Experiment completion timestamp, once completed. */
  @date()
  @column()
  @description("Experiment completion timestamp, once completed")
  completedAt?: Date;

  /** Experiment creation timestamp. */
  @date()
  @column()
  @description("Experiment creation timestamp")
  override createdAt!: Date;

  constructor(arg?: Partial<MastraEvalExperimentModel>) {
    super(arg);
  }
}

/**
 * Read-only mastra eval result row (SAA-836 O1, extends S2).
 *
 * One row per mastra storage experiment result — the eval outcome of one
 * dataset item attempt inside an experiment, including the JSON-safe
 * input/output/ground-truth triple and the per-item error mastra recorded.
 */
@uilistmodel("ngx-decaf-list-item", { icon: "ti-list-check" })
@uimodel("ngx-decaf-crud-form")
@description("Read-only mastra eval result row")
@table("mastra_eval_result")
@model()
export class MastraEvalResultModel extends BaseModel {
  /** Mastra storage experiment-result id (not generated: mastra owns it). */
  @pk({ type: String, generated: false })
  @description("Mastra storage experiment-result id")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.result.resultId.label",
    readonly: true,
  })
  resultId!: string;

  /** Mastra experiment id the result belongs to. */
  @column()
  @required()
  @index()
  @description("Mastra experiment id the result belongs to")
  @uilistprop("experimentId")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.result.experimentId.label",
    readonly: true,
  })
  experimentId!: string;

  /** Mastra dataset item id the result was produced for. */
  @column()
  @required()
  @description("Mastra dataset item id the result was produced for")
  @uilistprop("itemId")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.result.itemId.label",
    readonly: true,
  })
  itemId!: string;

  /** Dataset version the item was read from, when versioned. */
  @column()
  @type(Number)
  @description("Dataset version the item was read from, when versioned")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.result.itemDatasetVersion.label",
    readonly: true,
  })
  itemDatasetVersion?: number;

  /** Zero-based repetition index of the item within the experiment. */
  @column()
  @required()
  @type(Number)
  @description("Zero-based repetition index of the item within the experiment")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.result.attempt.label",
    readonly: true,
  })
  attempt!: number;

  /** Retry count mastra recorded for the attempt. */
  @column()
  @required()
  @type(Number)
  @description("Retry count mastra recorded for the attempt")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.result.retryCount.label",
    readonly: true,
  })
  retryCount!: number;

  /**
   * Result lifecycle status (required, never null): mastra's recorded status,
   * degrading to {@link MASTRA_EVAL_RESULT_STATUS_UNKNOWN} when the row
   * exposes none.
   */
  @column()
  @required()
  @type(String)
  @index()
  @description("Result lifecycle status")
  @uilistprop("status")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.result.status.label",
    readonly: true,
  })
  status!: string;

  /** JSON-safe eval input the item ran with, when recorded. */
  @column()
  @prop()
  @description("JSON-safe eval input the item ran with, when recorded")
  input?: unknown;

  /** JSON-safe eval output the item produced, when recorded. */
  @column()
  @prop()
  @description("JSON-safe eval output the item produced, when recorded")
  output?: unknown;

  /** JSON-safe ground truth the item was scored against, when recorded. */
  @column()
  @prop()
  @description("JSON-safe ground truth the item was scored against, when recorded")
  groundTruth?: unknown;

  /** JSON-safe error mastra recorded for the attempt, when it failed. */
  @column()
  @prop()
  @description("JSON-safe error mastra recorded for the attempt, when it failed")
  error?: Record<string, unknown>;

  /** Mastra trace id linking the attempt to its observability trace, when recorded. */
  @column()
  @index()
  @description("Mastra trace id linking the attempt to its observability trace, when recorded")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.result.traceId.label",
    readonly: true,
  })
  traceId?: string;

  /** Review/analysis tags mastra recorded on the result, when any. */
  @column()
  @description("Review/analysis tags mastra recorded on the result, when any")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.evals.result.tags.label",
    readonly: true,
  })
  tags?: string[];

  /** Result start timestamp. */
  @date()
  @column()
  @required()
  @description("Result start timestamp")
  startedAt!: Date;

  /** Result completion timestamp. */
  @date()
  @column()
  @required()
  @description("Result completion timestamp")
  completedAt!: Date;

  /** Result creation timestamp. */
  @date()
  @column()
  @description("Result creation timestamp")
  override createdAt!: Date;

  constructor(arg?: Partial<MastraEvalResultModel>) {
    super(arg);
  }
}

/** The union of the O1 read-only mastra eval models. */
export type MastraEvalModel = MastraEvalExperimentModel | MastraEvalResultModel;

/**
 * Raw mastra storage experiment row (structural subset, JSON-shaped). Every
 * member is `unknown`: the converter narrows each field defensively.
 */
export interface MastraStorageExperimentRow {
  /** Mastra storage experiment id. */
  id?: unknown;
  /** Experiment name. */
  name?: unknown;
  /** Experiment description. */
  description?: unknown;
  /** Mastra dataset id the experiment ran, or null. */
  datasetId?: unknown;
  /** Mastra dataset version the experiment pinned, or null. */
  datasetVersion?: unknown;
  /** Kind of executor the experiment ran against, or null. */
  targetType?: unknown;
  /** Mastra id of the executor the experiment ran against, or null. */
  targetId?: unknown;
  /** Scorer ids pinned at create time, or null. */
  scorerIds?: unknown;
  /** Experiment lifecycle status. */
  status?: unknown;
  /** Total dataset items the experiment planned to run. */
  totalItems?: unknown;
  /** Items that succeeded. */
  succeededCount?: unknown;
  /** Items that failed. */
  failedCount?: unknown;
  /** Items that were skipped. */
  skippedCount?: unknown;
  /** Experiment start timestamp. */
  startedAt?: unknown;
  /** Experiment completion timestamp. */
  completedAt?: unknown;
  /** Experiment creation timestamp. */
  createdAt?: unknown;
  /** Experiment last-update timestamp. */
  updatedAt?: unknown;
}

/** Raw mastra storage experiment-result row (structural subset, JSON-shaped). */
export interface MastraStorageExperimentResultRow {
  /** Mastra storage experiment-result id. */
  id?: unknown;
  /** Mastra experiment id the result belongs to. */
  experimentId?: unknown;
  /** Mastra dataset item id the result was produced for. */
  itemId?: unknown;
  /** Dataset version the item was read from, or null. */
  itemDatasetVersion?: unknown;
  /** Eval input the item ran with. */
  input?: unknown;
  /** Eval output the item produced, or null. */
  output?: unknown;
  /** Ground truth the item was scored against, or null. */
  groundTruth?: unknown;
  /** Error mastra recorded for the attempt, or null. */
  error?: unknown;
  /** Zero-based repetition index of the item within the experiment. */
  attempt?: unknown;
  /** Retry count mastra recorded for the attempt. */
  retryCount?: unknown;
  /** Mastra trace id linking the attempt to its observability trace, or null. */
  traceId?: unknown;
  /** Result lifecycle status, or null. */
  status?: unknown;
  /** Review/analysis tags on the result, or null. */
  tags?: unknown;
  /** Result start timestamp. */
  startedAt?: unknown;
  /** Result completion timestamp. */
  completedAt?: unknown;
  /** Result creation timestamp. */
  createdAt?: unknown;
}

/**
 * Converts a raw mastra experiment row into its read-only eval model shape.
 *
 * @param row - The raw mastra storage experiment row.
 * @returns The projected eval experiment model, or `undefined` when the row lacks a usable experiment id or creation date (never null — R7).
 */
export function mastraExperimentRowToModel(
  row: MastraStorageExperimentRow
): MastraEvalExperimentModel | undefined {
  const experimentId = stringOrNull(row.id);
  const createdAt = toDateOrNull(row.createdAt);
  if (!experimentId || !createdAt) return undefined;
  return new MastraEvalExperimentModel({
    experimentId,
    ...(stringOrNull(row.name) ? { name: stringOrNull(row.name) } : {}),
    ...(stringOrNull(row.description)
      ? { description: stringOrNull(row.description) }
      : {}),
    ...(stringOrNull(row.datasetId) ? { datasetId: stringOrNull(row.datasetId) } : {}),
    ...(typeof row.datasetVersion === "number" && Number.isFinite(row.datasetVersion)
      ? { datasetVersion: row.datasetVersion }
      : {}),
    ...(stringOrNull(row.targetType)
      ? { targetType: stringOrNull(row.targetType) }
      : {}),
    ...(stringOrNull(row.targetId) ? { targetId: stringOrNull(row.targetId) } : {}),
    ...(stringArrayOrNull(row.scorerIds)
      ? { scorerIds: stringArrayOrNull(row.scorerIds) }
      : {}),
    status: stringOrNull(row.status) ?? MASTRA_EVAL_STATUS_UNKNOWN,
    totalItems: countOf(row.totalItems, 0),
    succeededCount: countOf(row.succeededCount, 0),
    failedCount: countOf(row.failedCount, 0),
    skippedCount: countOf(row.skippedCount, 0),
    ...(toDateOrNull(row.startedAt) ? { startedAt: toDateOrNull(row.startedAt) } : {}),
    ...(toDateOrNull(row.completedAt)
      ? { completedAt: toDateOrNull(row.completedAt) }
      : {}),
    createdAt,
    updatedAt: toDateOrNull(row.updatedAt) ?? createdAt,
  });
}

/**
 * Converts a raw mastra experiment-result row into its read-only eval model
 * shape.
 *
 * @param row - The raw mastra storage experiment-result row.
 * @returns The projected eval result model, or `undefined` when the row lacks a usable result id, experiment id, item id, or the required dates (never null — R7).
 */
export function mastraExperimentResultRowToModel(
  row: MastraStorageExperimentResultRow
): MastraEvalResultModel | undefined {
  const resultId = stringOrNull(row.id);
  const experimentId = stringOrNull(row.experimentId);
  const itemId = stringOrNull(row.itemId);
  const startedAt = toDateOrNull(row.startedAt);
  const completedAt = toDateOrNull(row.completedAt);
  const createdAt = toDateOrNull(row.createdAt);
  if (!resultId || !experimentId || !itemId) return undefined;
  if (!startedAt || !completedAt || !createdAt) return undefined;
  const error = jsonSafeValueOrNull(row.error);
  return new MastraEvalResultModel({
    resultId,
    experimentId,
    itemId,
    ...(typeof row.itemDatasetVersion === "number" &&
    Number.isFinite(row.itemDatasetVersion)
      ? { itemDatasetVersion: row.itemDatasetVersion }
      : {}),
    attempt: countOf(row.attempt, 0),
    retryCount: countOf(row.retryCount, 0),
    status: stringOrNull(row.status) ?? MASTRA_EVAL_RESULT_STATUS_UNKNOWN,
    ...(jsonSafeValueOrNull(row.input) !== undefined
      ? { input: jsonSafeValueOrNull(row.input) }
      : {}),
    ...(jsonSafeValueOrNull(row.output) !== undefined
      ? { output: jsonSafeValueOrNull(row.output) }
      : {}),
    ...(jsonSafeValueOrNull(row.groundTruth) !== undefined
      ? { groundTruth: jsonSafeValueOrNull(row.groundTruth) }
      : {}),
    ...(error && typeof error === "object" && !Array.isArray(error)
      ? { error: error as Record<string, unknown> }
      : {}),
    ...(stringOrNull(row.traceId) ? { traceId: stringOrNull(row.traceId) } : {}),
    ...(stringArrayOrNull(row.tags) ? { tags: stringArrayOrNull(row.tags) } : {}),
    startedAt,
    completedAt,
    createdAt,
  });
}
