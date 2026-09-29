import { model } from "@decaf-ts/decorator-validation";
import { BaseModel, column, pk, table } from "@decaf-ts/core";

/**
 * Persistent run record for the graph run lifecycle (DECAF-50 §4.14): one
 * row per {@link GraphRun}, storing lifecycle status, the executed
 * document's fingerprint, inputs, result, and error payloads. Written and
 * read through {@link GraphRunModelService}, which adapts it to the
 * engine-side {@link GraphRun} shape.
 */
@table("graph_run")
@model()
export class GraphRunModel extends BaseModel {
  @pk({ type: String, generated: false })
  runId!: string;

  @column()
  workflowId!: string;

  @column()
  owner?: string;

  @column()
  status!: string;

  @column()
  documentFingerprint?: string;

  @column()
  inputs?: Record<string, unknown>;

  @column()
  result?: Record<string, unknown>;

  @column()
  error?: Record<string, unknown>;

  @column()
  override createdAt!: Date;

  @column()
  startedAt?: Date;

  @column()
  finishedAt?: Date;

  constructor(arg?: Partial<GraphRunModel>) {
    super(arg);
  }
}
