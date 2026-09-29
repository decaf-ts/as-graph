import { model } from "@decaf-ts/decorator-validation";
import { BaseModel, column, pk, table } from "@decaf-ts/core";
import type { GraphWorkflowDocument } from "../../shared/graph";

/**
 * Canonical workflow persistence model (DECAF-50 §4.10).
 *
 * `document` is the executable source of truth. `snapshot` is retained
 * temporarily (DECAF-50 §4.18 transition) so legacy persisted snapshots keep
 * loading through lossless read-path conversion; it must never become the
 * executable source of truth again and is removed at cutover (P7).
 *
 * `owner` implements the DECAF-48 `{ workflowId, ownerUser }` ownership tuple:
 * the authenticated user that created the workflow, or `undefined` for
 * system/standalone saves (tolerated per DECAF-48 §4.15).
 *
 * @class GraphWorkflowModel
 */
@table("graph_workflow")
@model()
export class GraphWorkflowModel extends BaseModel {
  @pk({ type: String, generated: false })
  workflowId!: string;

  @column()
  name?: string;

  @column()
  document?: GraphWorkflowDocument;

  @column()
  owner?: string;

  @column()
  snapshot?: Record<string, unknown>;

  constructor(arg?: Partial<GraphWorkflowModel>) {
    super(arg);
  }
}
