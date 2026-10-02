/**
 * @module as-graph/shared/graph/GraphRunModel
 * @summary Persistable graph run record (DECAF-50 §4.14).
 * @description Frontend-safe persistence model for a graph run: one row per run,
 * storing lifecycle status, the executed document's fingerprint, inputs, result and
 * error payloads. The model lives in the shared surface (it is a
 * `persistedModelClass`) so both the backend stores and the UI listing/forms use
 * the same decorated class. Engine-only conversion helpers (which reference the
 * engine {@link GraphRun} contract) live in
 * `as-graph/engine/runs/GraphRunConverters`.
 */
import { date, model, required, type } from "@decaf-ts/decorator-validation";
import { description, prop } from "@decaf-ts/decoration";
import { BaseModel, column, index, pk, table } from "@decaf-ts/core";
import { uielement, uilistmodel, uilistprop, uimodel } from "@decaf-ts/ui-decorators";

/**
 * Persistent run record for the graph run lifecycle (DECAF-50 §4.14).
 *
 * `runId` is the engine-assigned run id; `workflowId` and `status` are indexed
 * because the run history is listed and filtered by workflow and status.
 */
@uilistmodel("ngx-decaf-list-item", { icon: "ti-player-play" })
@uimodel("ngx-decaf-crud-form")
@description("Persistable graph run lifecycle record")
@table("graph_run")
@model()
export class GraphRunModel extends BaseModel {
  /** Engine-assigned run id (not generated: the engine owns it). */
  @pk({ type: String, generated: false })
  @description("Unique graph run id")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.run.id.label",
    readonly: true,
  })
  runId!: string;

  /** Workflow (document) id the run executes. */
  @column()
  @required()
  @index()
  @description("Workflow document id the run executes")
  @uilistprop("workflowId")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.run.workflowId.label",
  })
  workflowId!: string;

  /** Owning user; absent for anonymous callers. */
  @column()
  @description("Owning user; absent for anonymous callers")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.run.owner.label",
  })
  owner?: string;

  /** Current lifecycle status (`GraphRunStatus`). */
  @column()
  @required()
  @type(String)
  @index()
  @description("Current run lifecycle status")
  @uilistprop("status")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.run.status.label",
    readonly: true,
  })
  status!: string;

  /** Fingerprint of the executed document (stable SHA-256). */
  @column()
  @description("Fingerprint of the executed document")
  @uielement("ngx-decaf-crud-field", {
    label: "graph.run.fingerprint.label",
    readonly: true,
  })
  documentFingerprint?: string;

  /** Workflow input values keyed by input port id. */
  @column()
  @prop()
  @description("Workflow input values keyed by input port id")
  inputs?: Record<string, unknown>;

  /** Execution result, present on successful completion. */
  @column()
  @prop()
  @description("Execution result, present on successful completion")
  result?: Record<string, unknown>;

  /** Structured error payload, present on failure. */
  @column()
  @prop()
  @description("Structured error payload, present on failure")
  error?: Record<string, unknown>;

  /** Run creation timestamp. */
  @date()
  @column()
  @description("Run creation timestamp")
  override createdAt!: Date;

  /** Execution start timestamp, once it has started. */
  @date()
  @column()
  @description("Execution start timestamp, once it has started")
  startedAt?: Date;

  /** Terminal-state timestamp, once the run has finished. */
  @date()
  @column()
  @description("Terminal-state timestamp, once the run has finished")
  finishedAt?: Date;

  constructor(arg?: Partial<GraphRunModel>) {
    super(arg);
  }
}
