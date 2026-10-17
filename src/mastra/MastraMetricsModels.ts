/**
 * @module as-graph/mastra/MastraMetricsModels
 * @summary Read-only mastra metrics/list models (SAA-836 S2).
 * @description Persistable, frontend-safe projections of the mastra storage
 * metrics data (agent runs, scores, traces). The models are read-only: every
 * surface below serves reads only, and the backing adapter refuses writes
 * (fail-closed). Rows are JSON-safe: the converters sanitize every payload
 * member before a model is built.
 *
 * The module exports the three read-only models ({@link MastraRunMetricModel},
 * {@link MastraScoreMetricModel}, {@link MastraTraceMetricModel}), the raw
 * mastra storage row shapes they project from, and the row-to-model converters
 * the {@link module:as-graph/mastra/MastraMetricsAdapter} reads through.
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

/** Fallback status for a mastra run whose snapshot does not expose a status. */
export const MASTRA_METRICS_STATUS_UNKNOWN = "unknown";

/**
 * Removes every non-JSON-safe member from an unknown mastra payload value: a
 * value is kept only when the shared predicate certifies it JSON-safe and it
 * is a plain object (arrays and primitives are dropped).
 *
 * @param value - The raw mastra payload member (any shape).
 * @returns A JSON-safe clone of the object payload, or `undefined` when the value is absent, non-object, or not JSON-safe.
 */
function jsonSafeOrNull(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isGraphJsonSafeValue(value)) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return cloneGraphJsonValue(value as GraphJsonValue) as Record<string, unknown>;
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
 * Read-only mastra agent run metric row (SAA-836 S2).
 *
 * One row per mastra workflow run: `runId` is the mastra storage run id,
 * `workflowId` is the canonical workflow id (mastra storage `workflow_name`,
 * which the mastra compiler pins to the document id), and `snapshot` carries
 * the JSON-safe run snapshot payload.
 */
@uilistmodel("ngx-decaf-list-item", { icon: "ti-player-play" })
@uimodel("ngx-decaf-crud-form")
@description("Read-only mastra agent run metric row")
@table("mastra_run_metric")
@model()
export class MastraRunMetricModel extends BaseModel {
  /** Mastra storage run id (not generated: mastra owns it). */
  @pk({ type: String, generated: false })
  @description("Mastra storage run id")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.run.runId.label",
    readonly: true,
  })
  runId!: string;

  /** Canonical workflow id the run executed (mastra storage workflow_name). */
  @column()
  @required()
  @index()
  @description("Canonical workflow id the run executed")
  @uilistprop("workflowId")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.run.workflowId.label",
    readonly: true,
  })
  workflowId!: string;

  /** Mastra resource id attached to the run, when present. */
  @column()
  @description("Mastra resource id attached to the run, when present")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.run.resourceId.label",
    readonly: true,
  })
  resourceId?: string;

  /**
   * Derived lifecycle status of the run snapshot (required, never null):
   * resolved from the snapshot's `status` member, degrading to
   * {@link MASTRA_METRICS_STATUS_UNKNOWN} when the snapshot exposes none.
   */
  @column()
  @required()
  @type(String)
  @index()
  @description("Derived run lifecycle status")
  @uilistprop("status")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.run.status.label",
    readonly: true,
  })
  status!: string;

  /** JSON-safe run snapshot payload (served only to payload-authorized callers). */
  @column()
  @prop()
  @description("JSON-safe run snapshot payload")
  snapshot?: Record<string, unknown>;

  /** Run creation timestamp. */
  @date()
  @column()
  @description("Run creation timestamp")
  override createdAt!: Date;

  constructor(arg?: Partial<MastraRunMetricModel>) {
    super(arg);
  }
}

/**
 * Read-only mastra score metric row (SAA-836 S2).
 *
 * One row per mastra score record, narrowed to the run that produced it. The
 * `workflowId` anchor is filled by the metrics gateway from the owning run, so
 * every row is owner-scoped through the same canonical workflow the caller
 * accessed.
 */
@uilistmodel("ngx-decaf-list-item", { icon: "ti-star" })
@uimodel("ngx-decaf-crud-form")
@description("Read-only mastra score metric row")
@table("mastra_score_metric")
@model()
export class MastraScoreMetricModel extends BaseModel {
  /** Mastra score record id (not generated: mastra owns it). */
  @pk({ type: String, generated: false })
  @description("Mastra score record id")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.score.scoreId.label",
    readonly: true,
  })
  scoreId!: string;

  /** Mastra run id the score was recorded for. */
  @column()
  @required()
  @index()
  @description("Mastra run id the score was recorded for")
  @uilistprop("runId")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.score.runId.label",
    readonly: true,
  })
  runId!: string;

  /** Canonical workflow id the scored run executed (gateway-filled anchor). */
  @column()
  @required()
  @index()
  @description("Canonical workflow id the scored run executed")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.score.workflowId.label",
    readonly: true,
  })
  workflowId!: string;

  /** Mastra scorer id that produced the score. */
  @column()
  @required()
  @description("Mastra scorer id that produced the score")
  @uilistprop("scorerId")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.score.scorerId.label",
    readonly: true,
  })
  scorerId!: string;

  /** The numeric score mastra recorded. */
  @column()
  @required()
  @type(Number)
  @description("The numeric score mastra recorded")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.score.score.label",
    readonly: true,
  })
  score!: number;

  /** Mastra's reason for the score, when recorded. */
  @column()
  @description("Mastra's reason for the score, when recorded")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.score.reason.label",
    readonly: true,
  })
  reason?: string;

  /** JSON-safe scoring input, when recorded. */
  @column()
  @prop()
  @description("JSON-safe scoring input")
  input?: Record<string, unknown>;

  /** JSON-safe scoring output, when recorded. */
  @column()
  @prop()
  @description("JSON-safe scoring output")
  output?: Record<string, unknown>;

  /** Score creation timestamp. */
  @date()
  @column()
  @description("Score creation timestamp")
  override createdAt!: Date;

  constructor(arg?: Partial<MastraScoreMetricModel>) {
    super(arg);
  }
}

/**
 * Read-only mastra trace metric row (SAA-836 S2).
 *
 * One row per mastra observability span (the mastra trace unit served by the
 * storage domain), narrowed to the run that produced it. `traceId` groups the
 * spans of one mastra trace; `workflowId` is the gateway-filled owner anchor.
 */
@uilistmodel("ngx-decaf-list-item", { icon: "ti-route" })
@uimodel("ngx-decaf-crud-form")
@description("Read-only mastra trace metric row")
@table("mastra_trace_metric")
@model()
export class MastraTraceMetricModel extends BaseModel {
  /** Mastra span id (not generated: mastra owns it). */
  @pk({ type: String, generated: false })
  @description("Mastra span id")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.trace.spanId.label",
    readonly: true,
  })
  spanId!: string;

  /** Mastra trace id the span belongs to. */
  @column()
  @required()
  @index()
  @description("Mastra trace id the span belongs to")
  @uilistprop("traceId")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.trace.traceId.label",
    readonly: true,
  })
  traceId!: string;

  /** Mastra run id the span was recorded for. */
  @column()
  @required()
  @index()
  @description("Mastra run id the span was recorded for")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.trace.runId.label",
    readonly: true,
  })
  runId!: string;

  /** Canonical workflow id the traced run executed (gateway-filled anchor). */
  @column()
  @required()
  @index()
  @description("Canonical workflow id the traced run executed")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.trace.workflowId.label",
    readonly: true,
  })
  workflowId!: string;

  /** Span name mastra recorded. */
  @column()
  @required()
  @description("Span name mastra recorded")
  @uilistprop("name")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.trace.name.label",
    readonly: true,
  })
  name!: string;

  /** Span type mastra recorded. */
  @column()
  @required()
  @type(String)
  @description("Span type mastra recorded")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.trace.spanType.label",
    readonly: true,
  })
  spanType!: string;

  /** Trace status mastra recorded for the span. */
  @column()
  @required()
  @type(String)
  @index()
  @description("Trace status mastra recorded for the span")
  @uilistprop("status")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.metrics.trace.status.label",
    readonly: true,
  })
  status!: string;

  /** JSON-safe span summary (attributes plus error), when recorded. */
  @column()
  @prop()
  @description("JSON-safe span summary")
  summary?: Record<string, unknown>;

  /** Span start timestamp. */
  @date()
  @column()
  @description("Span start timestamp")
  startedAt?: Date;

  /** Span end timestamp, once the span ended. */
  @date()
  @column()
  @description("Span end timestamp")
  endedAt?: Date;

  constructor(arg?: Partial<MastraTraceMetricModel>) {
    super(arg);
  }
}

/** The union of the S2 read-only mastra metric models. */
export type MastraMetricModel =
  | MastraRunMetricModel
  | MastraScoreMetricModel
  | MastraTraceMetricModel;

/**
 * Raw mastra storage workflow-run row (structural subset, JSON-shaped). Every
 * member is `unknown`: the converter narrows each field defensively.
 */
export interface MastraStorageRunRow {
  /** Mastra storage run id. */
  runId?: unknown;
  /** Mastra storage workflow name (the canonical workflow id). */
  workflowName?: unknown;
  /** Mastra resource id attached to the run. */
  resourceId?: unknown;
  /** Run snapshot payload (object or serialized JSON string). */
  snapshot?: unknown;
  /** Run creation timestamp. */
  createdAt?: unknown;
  /** Run last-update timestamp. */
  updatedAt?: unknown;
}

/** Raw mastra storage score row (structural subset, JSON-shaped). */
export interface MastraStorageScoreRow {
  /** Mastra score record id. */
  id?: unknown;
  /** Mastra run id the score was recorded for. */
  runId?: unknown;
  /** Mastra scorer id that produced the score. */
  scorerId?: unknown;
  /** The numeric score mastra recorded. */
  score?: unknown;
  /** Mastra's reason for the score. */
  reason?: unknown;
  /** Scoring input payload. */
  input?: unknown;
  /** Scoring output payload. */
  output?: unknown;
  /** Score creation timestamp. */
  createdAt?: unknown;
}

/** Raw mastra storage trace span row (structural subset, JSON-shaped). */
export interface MastraStorageSpanRow {
  /** Mastra trace id the span belongs to. */
  traceId?: unknown;
  /** Mastra span id. */
  spanId?: unknown;
  /** Mastra run id the span was recorded for. */
  runId?: unknown;
  /** Span name mastra recorded. */
  name?: unknown;
  /** Span type mastra recorded. */
  spanType?: unknown;
  /** Trace status mastra recorded for the span. */
  status?: unknown;
  /** Span attributes payload. */
  attributes?: unknown;
  /** Span error payload. */
  error?: unknown;
  /** Span start timestamp. */
  startedAt?: unknown;
  /** Span end timestamp. */
  endedAt?: unknown;
}

/**
 * Extracts the run status from a mastra snapshot value (object or serialized
 * JSON string) without ever returning null: unknown snapshots degrade to the
 * documented {@link MASTRA_METRICS_STATUS_UNKNOWN} status.
 *
 * @param snapshot - The raw mastra run snapshot value.
 * @returns The snapshot's `status` string, or {@link MASTRA_METRICS_STATUS_UNKNOWN}.
 */
function runStatusOf(snapshot: unknown): string {
  let value = snapshot;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return MASTRA_METRICS_STATUS_UNKNOWN;
    }
  }
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>)["status"] === "string"
  ) {
    return (value as Record<string, unknown>)["status"] as string;
  }
  return MASTRA_METRICS_STATUS_UNKNOWN;
}

/**
 * Converts a raw mastra workflow-run row into its read-only model shape.
 *
 * @param row - The raw mastra storage run row.
 * @param workflowId - The canonical workflow id the run is anchored to (mastra storage `workflow_name`).
 * @returns The projected run metric model, or `undefined` when the row lacks a usable run id or creation date (never null — R7).
 */
export function mastraRunRowToModel(
  row: MastraStorageRunRow,
  workflowId: string
): MastraRunMetricModel | undefined {
  const runId = typeof row.runId === "string" ? row.runId : undefined;
  if (!runId) return undefined;
  const createdAt = toDateOrNull(row.createdAt);
  if (!createdAt) return undefined;
  const snapshot = jsonSafeOrNull(row.snapshot);
  return new MastraRunMetricModel({
    runId,
    workflowId,
    ...(typeof row.resourceId === "string" && row.resourceId
      ? { resourceId: row.resourceId }
      : {}),
    status: runStatusOf(row.snapshot),
    ...(snapshot ? { snapshot } : {}),
    createdAt,
    updatedAt: toDateOrNull(row.updatedAt) ?? createdAt,
  });
}

/**
 * Converts a raw mastra score row into its read-only model shape.
 *
 * @param row - The raw mastra storage score row.
 * @param workflowId - The canonical workflow id anchor (gateway-filled from the owning run).
 * @returns The projected score metric model, or `undefined` when the row lacks a usable id, run, scorer, finite score, or creation date (never null — R7).
 */
export function mastraScoreRowToModel(
  row: MastraStorageScoreRow,
  workflowId: string
): MastraScoreMetricModel | undefined {
  const scoreId = typeof row.id === "string" ? row.id : undefined;
  const runId = typeof row.runId === "string" ? row.runId : undefined;
  const scorerId = typeof row.scorerId === "string" ? row.scorerId : undefined;
  const createdAt = toDateOrNull(row.createdAt);
  if (!scoreId || !runId || !scorerId || !createdAt) return undefined;
  const score =
    typeof row.score === "number" && Number.isFinite(row.score)
      ? row.score
      : undefined;
  if (score === undefined) return undefined;
  return new MastraScoreMetricModel({
    scoreId,
    runId,
    workflowId,
    scorerId,
    score,
    ...(typeof row.reason === "string" && row.reason
      ? { reason: row.reason }
      : {}),
    ...(jsonSafeOrNull(row.input) ? { input: jsonSafeOrNull(row.input) } : {}),
    ...(jsonSafeOrNull(row.output)
      ? { output: jsonSafeOrNull(row.output) }
      : {}),
    createdAt,
  });
}

/**
 * Converts a raw mastra trace span row into its read-only model shape.
 *
 * @param row - The raw mastra storage span row.
 * @param workflowId - The canonical workflow id anchor (gateway-filled from the owning run).
 * @returns The projected trace metric model, or `undefined` when the row lacks a usable span id, trace id, run id, or name (never null — R7). A span without a run id cannot be owner-scoped, so it is skipped.
 */
export function mastraSpanRowToModel(
  row: MastraStorageSpanRow,
  workflowId: string
): MastraTraceMetricModel | undefined {
  const spanId = typeof row.spanId === "string" ? row.spanId : undefined;
  const traceId = typeof row.traceId === "string" ? row.traceId : undefined;
  const runId = typeof row.runId === "string" && row.runId ? row.runId : undefined;
  const name = typeof row.name === "string" ? row.name : undefined;
  if (!spanId || !traceId || !runId || !name) return undefined;
  const summary: Record<string, unknown> = {};
  const attributes = jsonSafeOrNull(row.attributes);
  if (attributes) summary["attributes"] = attributes;
  const error = jsonSafeOrNull(row.error);
  if (error) summary["error"] = error;
  return new MastraTraceMetricModel({
    spanId,
    traceId,
    runId,
    workflowId,
    name,
    spanType: typeof row.spanType === "string" ? row.spanType : "unknown",
    status: typeof row.status === "string" ? row.status : "unknown",
    ...(Object.keys(summary).length ? { summary } : {}),
    ...(toDateOrNull(row.startedAt) ? { startedAt: toDateOrNull(row.startedAt) } : {}),
    ...(toDateOrNull(row.endedAt) ? { endedAt: toDateOrNull(row.endedAt) } : {}),
  });
}
