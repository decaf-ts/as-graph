/**
 * @module as-graph/execution/store/GraphDataTableRepository
 * @summary Cross-run persistence store for the data-table node kind.
 * @description Decaf repository over {@link GraphDataTableModel} that the
 * `core.data.dataTable` nodes reach through the engine's `dataTableStore`
 * getter. Rows are keyed as `"<tableName>:<rowId>"` within the engine's value
 * adapter, so tables live in the same adapter as workflow values but are
 * namespaced and durable across runs. Table names are validated against a
 * conservative character allowlist before every operation, and contextual
 * arguments (`Context`) are passed through to the underlying repository
 * calls so caller-provided contexts (transactions, locks) are honoured.
 */
import {
  Repository,
  repository,
  type Adapter,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import { DefaultFlavour } from "@decaf-ts/decoration";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import { GraphDataTableModel } from "./GraphDataTableModel";

/** Character allowlist a table name must satisfy (letters, digits, `_.:-`). */
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * Builds the composite persistence id for a table row.
 *
 * @param tableName - The validated table name.
 * @param rowId - The caller-supplied row id.
 * @returns The composite id `<tableName>:<rowId>`.
 */
function tableRowId(tableName: string, rowId: string): string {
  return `${tableName}:${rowId}`;
}

/**
 * Validates a table name against the conservative allowlist.
 *
 * @param tableName - The name to validate.
 * @throws {GraphExecutionError} with code `GRAPH_DATA_TABLE_INVALID_NAME` when
 *   the name is empty or contains characters outside the allowlist.
 */
function assertTableName(tableName: string): void {
  if (!tableName || !TABLE_NAME_PATTERN.test(tableName)) {
    throw new GraphExecutionError(
      `Data table name '${tableName}' is invalid`,
      "GRAPH_DATA_TABLE_INVALID_NAME",
      { tableName }
    );
  }
}

/**
 * Flattens a persisted model back into the row record the nodes see, with the
 * row id exposed as `id`.
 *
 * @param model - The persisted model.
 * @returns The plain row record.
 */
function toRecord(model: GraphDataTableModel): Record<string, unknown> {
  return { id: model.rowId, ...model.data };
}

/**
 * Cross-run data-table persistence over the engine's value adapter.
 *
 * The repository is registered against the default flavour via
 * `@repository(GraphDataTableModel, DefaultFlavour)` so
 * {@linkcode createGraphDataTableRepository} can resolve the flavour-specific
 * subclass rather than instantiating this base class directly.
 */
@repository(GraphDataTableModel, DefaultFlavour)
export class GraphDataTableRepository extends Repository<
  GraphDataTableModel,
  Adapter<any, any, any, any>
> {
  /**
   * Creates the repository against the engine's value adapter.
   *
   * @param adapter - The adapter backing the store; resolved from the
   *   registry when omitted.
   */
  constructor(adapter?: Adapter<any, any, any, any>) {
    super(adapter, GraphDataTableModel, true);
  }

  /**
   * Inserts a new row, storing its payload under `data`.
   *
   * @param tableName - The validated table name.
   * @param rowId - The caller-supplied row id.
   * @param data - The row payload.
   * @param args - Optional contextual arguments (e.g. a `Context`).
   * @returns The stored row record with its `id`.
   * @throws {GraphExecutionError} with code `GRAPH_DATA_TABLE_INVALID_NAME`
   *   when the table name is invalid.
   */
  async insertRow(
    tableName: string,
    rowId: string,
    data: Record<string, unknown>,
    ...args: MaybeContextualArg<Context>
  ): Promise<Record<string, unknown>> {
    assertTableName(tableName);
    const now = new Date();
    const model = new GraphDataTableModel({
      id: tableRowId(tableName, rowId),
      tableName,
      rowId,
      data: { ...data },
      createdAt: now,
      updatedAt: now,
    });
    const created = (await this.create(model, ...args)) as GraphDataTableModel;
    return toRecord(created);
  }

  /**
   * Inserts the row when absent, or replaces its whole payload when present.
   *
   * @param tableName - The validated table name.
   * @param rowId - The caller-supplied row id.
   * @param data - The row payload (replaces any previous payload entirely).
   * @param args - Optional contextual arguments (e.g. a `Context`).
   * @returns The stored row record with its `id`.
   * @throws {GraphExecutionError} with code `GRAPH_DATA_TABLE_INVALID_NAME`
   *   when the table name is invalid.
   */
  async upsertRow(
    tableName: string,
    rowId: string,
    data: Record<string, unknown>,
    ...args: MaybeContextualArg<Context>
  ): Promise<Record<string, unknown>> {
    assertTableName(tableName);
    const existing = await this.readRow(tableName, rowId, ...args);
    if (!existing) return this.insertRow(tableName, rowId, data, ...args);
    const model = (await this.read(
      tableRowId(tableName, rowId),
      ...args
    )) as GraphDataTableModel;
    model.data = { ...data };
    model.updatedAt = new Date();
    const updated = (await this.update(model, ...args)) as GraphDataTableModel;
    return toRecord(updated);
  }

  /**
   * Reads a single row.
   *
   * A missing row (or an adapter error reading it) resolves to `undefined`
   * rather than throwing, matching the data-table node's nil-skipping
   * semantics.
   *
   * @param tableName - The validated table name.
   * @param rowId - The caller-supplied row id.
   * @param args - Optional contextual arguments (e.g. a `Context`).
   * @returns The row record, or `undefined` when absent.
   * @throws {GraphExecutionError} with code `GRAPH_DATA_TABLE_INVALID_NAME`
   *   when the table name is invalid.
   */
  async readRow(
    tableName: string,
    rowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<Record<string, unknown> | undefined> {
    assertTableName(tableName);
    try {
      const model = (await this.read(
        tableRowId(tableName, rowId),
        ...args
      )) as GraphDataTableModel;
      return toRecord(model);
    } catch {
      return undefined;
    }
  }

  /**
   * Lists the rows of one table.
   *
   * The whole adapter is selected and then filtered by `tableName` — table
   * namespacing is enforced in-memory, not by the query. Rows are ordered by
   * `rowId` (lexicographic) for deterministic output, and a finite
   * non-negative `limit` slices the front.
   *
   * @param tableName - The validated table name.
   * @param limit - Optional maximum row count.
   * @param args - Optional contextual arguments (e.g. a `Context`).
   * @returns The (possibly limited) row records, ordered by `rowId`.
   * @throws {GraphExecutionError} with code `GRAPH_DATA_TABLE_INVALID_NAME`
   *   when the table name is invalid.
   */
  async listRows(
    tableName: string,
    limit?: number,
    ...args: MaybeContextualArg<Context>
  ): Promise<Record<string, unknown>[]> {
    assertTableName(tableName);
    const models = (await this.select().execute(
      ...args
    )) as GraphDataTableModel[];
    const rows = models
      .filter((model) => model.tableName === tableName)
      .sort((left, right) => left.rowId.localeCompare(right.rowId))
      .map(toRecord);
    if (limit !== undefined && Number.isFinite(limit) && limit >= 0) {
      return rows.slice(0, Math.floor(limit));
    }
    return rows;
  }

  /**
   * Deletes a single row.
   *
   * @param tableName - The validated table name.
   * @param rowId - The caller-supplied row id.
   * @param args - Optional contextual arguments (e.g. a `Context`).
   * @returns `true` when the delete succeeded, `false` when the row was
   *   absent or the adapter rejected the delete.
   * @throws {GraphExecutionError} with code `GRAPH_DATA_TABLE_INVALID_NAME`
   *   when the table name is invalid.
   */
  async deleteRow(
    tableName: string,
    rowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<boolean> {
    assertTableName(tableName);
    try {
      await this.delete(tableRowId(tableName, rowId), ...args);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deletes every row of a table.
   *
   * Implemented as a sequential `deleteRow` per listed row, so a failure
   * midway leaves the remaining rows intact.
   *
   * @param tableName - The validated table name.
   * @param args - Optional contextual arguments (e.g. a `Context`).
   * @returns The number of rows that were listed for deletion.
   * @throws {GraphExecutionError} with code `GRAPH_DATA_TABLE_INVALID_NAME`
   *   when the table name is invalid.
   */
  async clearTable(
    tableName: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<number> {
    const rows = await this.listRows(tableName, undefined, ...args);
    for (const row of rows) {
      await this.deleteRow(tableName, String(row.id), ...args);
    }
    return rows.length;
  }
}

/**
 * Binds the data-table repository to a specific adapter.
 *
 * The `@repository` registration resolves the flavour-specific repository
 * constructor registered for {@link GraphDataTableModel} under the adapter's
 * alias, so the returned instance carries whichever flavour behaviour the
 * adapter requires rather than the base class. This is the adapter-binding
 * entrypoint the engine's `dataTableStore` getter uses.
 *
 * @param adapter - The engine's value adapter.
 * @returns A repository instance bound to `adapter`.
 */
export function createGraphDataTableRepository(
  adapter: Adapter<any, any, any, any>
): GraphDataTableRepository {
  const Registered = Repository.forModel(GraphDataTableModel, adapter.alias)
    .constructor as new (
    adapter: Adapter<any, any, any, any>
  ) => GraphDataTableRepository;
  return new Registered(adapter);
}
