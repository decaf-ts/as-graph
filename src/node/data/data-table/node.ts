/**
 * @module as-graph/nodes/data/data-table
 * @summary Data Table data node declaration (DECAF-746 Data family).
 * @description Data Table — durable cross-run persistence for the engine. The
 * node resolves the engine's `dataTableStore` (`GraphDataTableRepository`,
 * bound to the engine's value adapter) and fails closed with
 * `GRAPH_ENGINE_NOT_AVAILABLE` when no engine is reachable. Per operation:
 * `insert`/`upsert` write rows resolved from the `value` input (record items
 * only, falling back to the configured `row` property) under row ids taken
 * from the configured `rowId`, then the row's `rowIdField` (default `id` —
 * string values kept, numbers stringified), then a generated UUID; `get` and
 * `delete` require a `rowId` and read/delete one row (`delete` reports the
 * outcome on both `result` and `count`); `list` returns up to `limit` rows in
 * `rowId` order with their count; `clear` deletes every row of the table and
 * reports how many were listed.
 */
import { randomUUID } from "node:crypto";
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import type { GraphDataTableRepository } from "../../../engine/store/GraphDataTableRepository";
import { asGraphDataArray, isGraphDataRecord } from "../support";

/** What the node does against the named table. */
export type DataTableOperation =
  | "insert"
  | "upsert"
  | "get"
  | "list"
  | "delete"
  | "clear";

/** Inputs accepted by the Data Table node. */
export type DataTableNodeInput = Record<string, unknown>;

/** Outputs produced by the Data Table node. */
export interface DataTableNodeOutput {
  result: unknown;
  count?: number;
}

/**
 * Data Table data node: performs durable insert/upsert/get/list/delete/clear
 * operations against the engine's data-table store.
 */
@node("core.data.dataTable", {
  kind: "core.data.dataTable",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-table",
  width: 96,
  height: 96,
  labels: ["data", "table", "persistence"],
  metadata: {
    title: "graph.node.data.data_table.name",
    description: "graph.node.data.data_table.description",
  },
})
@model()
export class DataTableNode extends GraphNode<
  DataTableNodeInput,
  DataTableNodeOutput
> {
  /**
   * Dispatches the configured operation against the engine's data-table store.
   *
   * @param request - The execution request carrying the optional `value`
   *   row payload.
   * @param context - The execution context whose engine provides the
   *   `dataTableStore`.
   * @returns The operation's result (and affected-row `count` where it
   *   applies).
   * @throws {GraphExecutionError} with code `GRAPH_ENGINE_NOT_AVAILABLE` when
   *   the context has no engine or the engine no store, `GRAPH_DATA_TABLE_NAME_REQUIRED`
   *   when no `tableName` is configured, `GRAPH_DATA_TABLE_ROW_ID_REQUIRED`
   *   when `get`/`delete` run without a `rowId`, `GRAPH_DATA_TABLE_UNSUPPORTED_OPERATION`
   *   for an unknown `operation`, and `GRAPH_DATA_TABLE_INVALID_NAME` (from
   *   the store) when the table name is invalid.
   */
  override async execute(
    request: GraphNodeExecutionRequest<DataTableNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const store = context.engine?.dataTableStore;
    if (!store) {
      throw new GraphExecutionError(
        "Data table node requires engine access",
        "GRAPH_ENGINE_NOT_AVAILABLE"
      );
    }
    if (!this.tableName) {
      throw new GraphExecutionError(
        "Data table node requires a table name",
        "GRAPH_DATA_TABLE_NAME_REQUIRED"
      );
    }

    switch (this.operation) {
      case "insert":
        return { result: await this.insertRows(request, store, context) };
      case "upsert":
        return { result: await this.upsertRows(request, store, context) };
      case "get": {
        if (!this.rowId) {
          throw new GraphExecutionError(
            "Data table 'get' requires a row id",
            "GRAPH_DATA_TABLE_ROW_ID_REQUIRED"
          );
        }
        const row = await store.readRow(
          this.tableName,
          this.rowId,
          context
        );
        return { result: row ?? null };
      }
      case "list": {
        const rows = await store.listRows(
          this.tableName,
          this.limit,
          context
        );
        return { result: rows, count: rows.length };
      }
      case "delete": {
        if (!this.rowId) {
          throw new GraphExecutionError(
            "Data table 'delete' requires a row id",
            "GRAPH_DATA_TABLE_ROW_ID_REQUIRED"
          );
        }
        const deleted = await store.deleteRow(
          this.tableName,
          this.rowId,
          context
        );
        return { result: deleted, count: deleted ? 1 : 0 };
      }
      case "clear": {
        const count = await store.clearTable(this.tableName, context);
        return { result: count, count };
      }
      default:
        throw new GraphExecutionError(
          `Unsupported data table operation '${String(this.operation)}'`,
          "GRAPH_DATA_TABLE_UNSUPPORTED_OPERATION",
          { operation: this.operation }
        );
    }
  }

  /**
   * Resolves the rows to insert or upsert.
   *
   * Record items of the `value` input win; when none are present the
   * configured `row` property is used as a single row.
   *
   * @param request - The execution request carrying the optional `value`
   *   input.
   * @returns The rows to persist (possibly empty).
   */
  private rowsOf(
    request: GraphNodeExecutionRequest<DataTableNodeInput>
  ): Record<string, unknown>[] {
    const value = request.inputs["value"];
    const rows = asGraphDataArray(value).filter(isGraphDataRecord);
    if (rows.length > 0) return rows;
    if (isGraphDataRecord(this.row)) return [this.row];
    return [];
  }

  /**
   * Inserts each resolved row, generating a UUID row id when neither the
   * configured `rowId` nor the row's id field supplies one.
   *
   * @param request - The execution request carrying the row payload.
   * @param store - The engine's data-table repository.
   * @param context - The execution context passed through to the store.
   * @returns The stored row records.
   */
  private async insertRows(
    request: GraphNodeExecutionRequest<DataTableNodeInput>,
    store: GraphDataTableRepository,
    context: GraphExecutionContext
  ): Promise<Record<string, unknown>[]> {
    const rows = this.rowsOf(request);
    const inserted: Record<string, unknown>[] = [];
    for (const row of rows) {
      const rowId = this.rowId ?? this.rowIdOf(row) ?? randomUUID();
      inserted.push(await store.insertRow(this.tableName, rowId, row, context));
    }
    return inserted;
  }

  /**
   * Upserts each resolved row with the same row-id resolution as
   * {@linkcode DataTableNode.insertRows}.
   *
   * @param request - The execution request carrying the row payload.
   * @param store - The engine's data-table repository.
   * @param context - The execution context passed through to the store.
   * @returns The stored row records.
   */
  private async upsertRows(
    request: GraphNodeExecutionRequest<DataTableNodeInput>,
    store: GraphDataTableRepository,
    context: GraphExecutionContext
  ): Promise<Record<string, unknown>[]> {
    const rows = this.rowsOf(request);
    const upserted: Record<string, unknown>[] = [];
    for (const row of rows) {
      const rowId = this.rowId ?? this.rowIdOf(row) ?? randomUUID();
      upserted.push(await store.upsertRow(this.tableName, rowId, row, context));
    }
    return upserted;
  }

  /**
   * Extracts a row id from the row itself.
   *
   * The configured `rowIdField` (default `id`) is read from the row; string
   * values are kept and numbers are stringified, anything else yields
   * `undefined` so a generated UUID can take over.
   *
   * @param row - The candidate row.
   * @returns The row id, or `undefined` when the row carries none.
   */
  private rowIdOf(row: Record<string, unknown>): string | undefined {
    const key = this.rowIdField || "id";
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
    return undefined;
  }

  @input({ handle: "value" })
  value?: unknown;

  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.data_table.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: DataTableOperation = "insert";

  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.data_table.fields.tableName.label",
    placeholder: "graph.node.data.data_table.fields.tableName.placeholder",
    type: "text",
  })
  @input({ handle: "tableName", userControlled: true })
  tableName: string = "default";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.data_table.fields.rowId.label",
    placeholder: "graph.node.data.data_table.fields.rowId.placeholder",
    type: "text",
  })
  @input({ handle: "rowId", userControlled: true })
  rowId?: string;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.data_table.fields.rowIdField.label",
    placeholder: "graph.node.data.data_table.fields.rowIdField.placeholder",
    type: "text",
  })
  @input({ handle: "rowIdField", userControlled: true })
  rowIdField?: string;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.data_table.fields.row.label",
    type: "json",
  })
  @input({ handle: "row", userControlled: true, type: "object" })
  row?: Record<string, unknown>;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.data_table.fields.limit.label",
    type: "number",
  })
  @input({ handle: "limit", userControlled: true })
  limit?: number;

  @required()
  @output({ handle: "result" })
  result!: unknown;

  @output({ handle: "count" })
  count?: number;
}
