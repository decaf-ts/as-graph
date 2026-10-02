/**
 * @module as-graph/ram/GraphRunEventModel
 * @summary Persistable run event envelope (DECAF-50 §4.14–§4.16).
 * @description Persistence model for {@link GraphRunEventEnvelope}. The
 * `id` is `runId:sequence` so events are addressed and ordered deterministically
 * within a run; the payload/error columns are stored JSON-safe.
 */
import { list, model } from "@decaf-ts/decorator-validation";
import { BaseModel, column, index, pk, table } from "@decaf-ts/core";
import type { GraphRunEventEnvelope } from "../shared/graph";
import type { GraphExecutionErrorPayload, GraphExecutionEventType } from "../shared/graph";

/** Persistable run event envelope row. */
@table("graph_run_event")
@model()
export class GraphRunEventModel extends BaseModel {
  /** `runId:sequence` composite id. */
  @pk({ type: String, generated: false })
  id!: string;

  /** Run the event belongs to (indexed). */
  @column()
  @index()
  runId!: string;

  /** Workflow the run executes. */
  @column()
  workflowId!: string;

  /** Monotonic per-run event ordering key (indexed). */
  @column()
  @index()
  sequence!: number;

  /** {@link GraphExecutionEventType} discriminant of the event. */
  @column()
  type!: string;

  /** ISO timestamp of when the event was emitted. */
  @column()
  timestamp!: string;

  /** Node id the event relates to, when node-scoped. */
  @column()
  nodeId?: string;

  /** Edge id the event relates to, when edge-scoped. */
  @column()
  edgeId?: string;

  /** JSON-safe event payload, when the type carries one. */
  @column()
  payload?: Record<string, unknown>;

  /** JSON-safe error payload, for failed executions. */
  @column()
  error?: Record<string, unknown>;

  /** Parent run id, for child runs spawned by loops or boundaries. */
  @column()
  parentRunId?: string;

  /** Execution path segments (parent chain) identifying the nested execution scope. */
  @column()
  @list(String)
  path?: string[];

  constructor(arg?: Partial<GraphRunEventModel>) {
    super(arg);
  }
}

/** Converts a run event envelope into its persistable model row. */
export function envelopeToModel(
  event: GraphRunEventEnvelope
): GraphRunEventModel {
  return new GraphRunEventModel({
    id: `${event.runId}:${event.sequence}`,
    runId: event.runId,
    workflowId: event.workflowId,
    sequence: event.sequence,
    type: event.type,
    timestamp: event.timestamp,
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    ...(event.edgeId ? { edgeId: event.edgeId } : {}),
    ...(event.payload !== undefined
      ? { payload: event.payload as Record<string, unknown> }
      : {}),
    ...(event.error
      ? { error: event.error as unknown as Record<string, unknown> }
      : {}),
    ...(event.parentRunId ? { parentRunId: event.parentRunId } : {}),
    ...(event.path ? { path: [...event.path] } : {}),
  });
}

/** Converts a persistable model row back into a run event envelope. */
export function modelToEnvelope(
  model: GraphRunEventModel
): GraphRunEventEnvelope {
  return {
    runId: model.runId,
    workflowId: model.workflowId,
    sequence: model.sequence,
    type: model.type as GraphExecutionEventType,
    timestamp: model.timestamp,
    ...(model.nodeId ? { nodeId: model.nodeId } : {}),
    ...(model.edgeId ? { edgeId: model.edgeId } : {}),
    ...(model.payload !== undefined
      ? { payload: model.payload as GraphRunEventEnvelope["payload"] }
      : {}),
    ...(model.error
      ? { error: model.error as unknown as GraphExecutionErrorPayload }
      : {}),
    ...(model.parentRunId ? { parentRunId: model.parentRunId } : {}),
    ...(model.path ? { path: [...model.path] } : {}),
  };
}
