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
  Condition,
  OrderDirection,
  Repository,
  repository,
  type Adapter,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import { DefaultFlavour } from "@decaf-ts/decoration";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import {
  GRAPH_DATA_TABLE_MAX_LIST_ROWS,
  GRAPH_DATA_TABLE_MAX_ROWS,
  GRAPH_DATA_TABLE_MAX_ROW_BYTES,
} from "../constants";
import { GraphDataTableModel } from "./GraphDataTableModel";

/**
 * Character allowlist a table name must satisfy (letters, digits, `_.-`).
 * `:` is intentionally excluded: it is the composite-id separator, so allowing
 * it in a table name would let `t:x`/`y` collide with `t`/`x:y`.
 */
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Maximum accepted table-name length. */
const MAX_TABLE_NAME_LENGTH = 128;

/** Maximum accepted row-id length. */
const MAX_ROW_ID_LENGTH = 256;

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
  if (
    !tableName ||
    tableName.length > MAX_TABLE_NAME_LENGTH ||
    !TABLE_NAME_PATTERN.test(tableName)
  ) {
    throw new GraphExecutionError(
      `Data table name '${tableName}' is invalid`,
      "GRAPH_DATA_TABLE_INVALID_NAME",
      { tableName }
    );
  }
}

/**
 * Validates a caller-supplied row id.
 *
 * @param rowId - The row id to validate.
 * @throws {GraphExecutionError} with code `GRAPH_DATA_TABLE_INVALID_ROW_ID`
 *   when the id is empty or too long.
 */
function assertRowId(rowId: string): void {
  if (!rowId || rowId.length > MAX_ROW_ID_LENGTH) {
    throw new GraphExecutionError(
      `Data table row id '${rowId}' is invalid`,
      "GRAPH_DATA_TABLE_INVALID_ROW_ID",
      { rowId }
    );
  }
}

/**
 * Rejects a row payload whose serialized form exceeds the per-row byte cap.
 *
 * @param data - The row payload.
 * @throws {GraphExecutionError} with code `GRAPH_DATA_TABLE_ROW_TOO_LARGE`
 *   when the payload is not JSON-serializable or exceeds the cap.
 */
function assertRowSize(data: Record<string, unknown>): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch {
    throw new GraphExecutionError(
      "Data table row payload is not JSON-serializable",
      "GRAPH_DATA_TABLE_ROW_TOO_LARGE",
      { limitBytes: GRAPH_DATA_TABLE_MAX_ROW_BYTES }
    );
  }
  if (serialized === undefined) {
    throw new GraphExecutionError(
      "Data table row payload is not JSON-serializable",
      "GRAPH_DATA_TABLE_ROW_TOO_LARGE",
      { limitBytes: GRAPH_DATA_TABLE_MAX_ROW_BYTES }
    );
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > GRAPH_DATA_TABLE_MAX_ROW_BYTES) {
    throw new GraphExecutionError(
      `Data table row payload exceeds the ${GRAPH_DATA_TABLE_MAX_ROW_BYTES}-byte limit`,
      "GRAPH_DATA_TABLE_ROW_TOO_LARGE",
      { bytes, limitBytes: GRAPH_DATA_TABLE_MAX_ROW_BYTES }
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
  // The row identity always wins over a payload member named `id`, so a stored
  // row cannot masquerade as a different row on read.
  return { ...model.data, id: model.rowId };
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
    assertRowId(rowId);
    assertRowSize(data);
    await this.assertRowCapacity(tableName, ...args);
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
    assertRowId(rowId);
    assertRowSize(data);
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
    assertRowId(rowId);
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
    const requested =
      limit !== undefined && Number.isFinite(limit) && limit >= 0
        ? Math.floor(limit)
        : GRAPH_DATA_TABLE_MAX_LIST_ROWS;
    if (requested === 0) return [];
    const effective = Math.min(requested, GRAPH_DATA_TABLE_MAX_LIST_ROWS);
    const models = (await this.select()
      .where(Condition.attr<GraphDataTableModel>("tableName").eq(tableName))
      .orderBy("rowId", OrderDirection.ASC)
      .limit(effective)
      .execute(...args)) as GraphDataTableModel[];
    return models.map(toRecord);
  }

  /**
   * Enforces the per-table row cap before inserting a new row.
   *
   * Tables are partitioned by the query-side `tableName` filter; this probe
   * uses the same bounded list query, so it never scans the whole adapter.
   *
   * @param tableName - The validated table name.
   * @param args - Optional contextual arguments.
   * @throws {GraphExecutionError} with code `GRAPH_DATA_TABLE_ROW_LIMIT_EXCEEDED`
   *   when the table already holds the maximum number of rows.
   */
  private async assertRowCapacity(
    tableName: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    const rows = await this.listRows(tableName, GRAPH_DATA_TABLE_MAX_ROWS, ...args);
    if (rows.length >= GRAPH_DATA_TABLE_MAX_ROWS) {
      throw new GraphExecutionError(
        `Data table '${tableName}' reached the ${GRAPH_DATA_TABLE_MAX_ROWS}-row limit`,
        "GRAPH_DATA_TABLE_ROW_LIMIT_EXCEEDED",
        { tableName, limit: GRAPH_DATA_TABLE_MAX_ROWS }
      );
    }
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
    assertRowId(rowId);
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
