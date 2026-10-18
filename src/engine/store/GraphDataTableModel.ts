/**
 * @module as-graph/execution/store/GraphDataTableModel
 * @summary Persistence model backing the data-table store.
 * @description Decaf model persisted through the engine's value adapter for
 * the `core.data.dataTable` node kind. Each row is stored under a composite
 * identity of `"<tableName>:<rowId>"` so tables namespace themselves within
 * one adapter, with `tableName` and `rowId` indexed for lookups and the row
 * payload kept verbatim under `data`. Cross-run durable state: unlike workflow
 * run values, rows survive their originating run.
 */
import { model } from "@decaf-ts/decorator-validation";
import { BaseModel, column, index, pk, table } from "@decaf-ts/core";

/**
 * Graph data-table row model: one persisted row of a named data table.
 */
@table("graph_data_table")
@model()
export class GraphDataTableModel extends BaseModel {
  /** Composite persistence id (`<tableName>:<rowId>`), not auto-generated. */
  @pk({ type: String, generated: false })
  id!: string;

  /** Name of the table the row belongs to. */
  @column()
  @index()
  tableName!: string;

  /** Caller-supplied row id within the table. */
  @column()
  @index()
  rowId!: string;

  /** The row's payload, kept as-is. */
  @column()
  data!: Record<string, unknown>;

  /** Row creation timestamp. */
  @column()
  override createdAt!: Date;

  /** Row last-update timestamp. */
  @column()
  override updatedAt!: Date;

  /**
   * Creates a data-table row model.
   *
   * @param arg - Optional partial model to hydrate from.
   */
  constructor(arg?: Partial<GraphDataTableModel>) {
    super(arg);
  }
}
