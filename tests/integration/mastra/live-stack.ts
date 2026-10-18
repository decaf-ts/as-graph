/**
 * @module as-graph/tests/integration/mastra/live-stack
 * @summary Live-stack helpers for the mastra integration suite: the real
 * `PostgresStore` from `@mastra/pg` over the SAA-920 Compose stack.
 * @description The stack is selected through `MASTRA_IT_POSTGRES_URL` (already
 * URL-encoded) or `GRAPH_IT_POSTGRES_URL`; discrete
 * `MASTRA_IT_PGHOST`/`MASTRA_IT_PGPORT`/`MASTRA_IT_PGDATABASE`/`MASTRA_IT_PGUSER`/
 * `MASTRA_IT_PGPASSWORD` variables are accepted as a fallback. The store points
 * at the `mastra` schema, never runs DDL (`disableInit: true`) because the
 * stack bootstrap owns migrations, and uses a unique store id per runtime.
 * Suites report honestly as skipped when no connection is configured.
 */
import { describe } from "@jest/globals";
import { Mastra } from "@mastra/core/mastra";
import { PostgresStore } from "@mastra/pg";
import type { DataSourceOptions } from "typeorm";

/** The schema the SAA-920 bootstrap creates and the runtime role owns. */
export const LIVE_SCHEMA = "mastra";

/** Resolved live-stack connection details. */
export interface LivePostgresConfig {
  /** Encoded Postgres DSN. */
  connectionString: string;
  /** Schema holding the mastra domain tables. */
  schemaName: string;
}

/**
 * Resolves the live-stack connection from the environment.
 *
 * @returns The connection, or `undefined` when no live stack is configured.
 */
export function livePostgresConfig(): LivePostgresConfig | undefined {
  const dsn =
    process.env["MASTRA_IT_POSTGRES_URL"]?.trim() ||
    process.env["GRAPH_IT_POSTGRES_URL"]?.trim();
  const schemaName =
    process.env["MASTRA_IT_POSTGRES_SCHEMA"]?.trim() || LIVE_SCHEMA;
  if (dsn) return { connectionString: dsn, schemaName };
  const host = process.env["MASTRA_IT_PGHOST"]?.trim();
  const user = process.env["MASTRA_IT_PGUSER"]?.trim();
  const database = process.env["MASTRA_IT_PGDATABASE"]?.trim();
  const password = process.env["MASTRA_IT_PGPASSWORD"];
  if (!host || !user || !database || password === undefined) return undefined;
  const port = process.env["MASTRA_IT_PGPORT"]?.trim() || "5432";
  return {
    connectionString: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
      password
    )}@${host}:${port}/${database}`,
    schemaName,
  };
}

/**
 * The durable as-graph adapter options over the same live database.
 *
 * @returns TypeORM options for the `asgraph` schema, or `undefined` when no
 * live stack is configured.
 */
export function liveAsGraphDataSourceOptions(): DataSourceOptions | undefined {
  const config = livePostgresConfig();
  if (!config) return undefined;
  return {
    type: "postgres",
    url: config.connectionString,
    schema: process.env["GRAPH_IT_POSTGRES_SCHEMA"]?.trim() || "asgraph",
    synchronize: false,
  } as DataSourceOptions;
}

/** True when a live stack is configured; suites skip otherwise. */
export const liveStackEnabled = livePostgresConfig() !== undefined;

/**
 * `describe` when a live stack is configured, `describe.skip` otherwise.
 */
export const liveDescribe = liveStackEnabled ? describe : describe.skip;

const openStores = new Set<PostgresStore>();
let sharedStore: PostgresStore | undefined;

/**
 * Creates a real `PostgresStore` over the live stack and tracks it so the
 * suite can close every pool it opened.
 *
 * @param idPrefix - Human-readable prefix for the unique store id.
 * @returns The live `PostgresStore`.
 */
export function createLiveStorage(idPrefix = "as-graph-it"): PostgresStore {
  const config = livePostgresConfig();
  if (!config) {
    throw new Error(
      "No live mastra stack configured: set MASTRA_IT_POSTGRES_URL (or GRAPH_IT_POSTGRES_URL) to the encoded SAA-920 Postgres DSN"
    );
  }
  const store = new PostgresStore({
    id: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    connectionString: config.connectionString,
    schemaName: config.schemaName,
    disableInit: true,
  });
  openStores.add(store);
  return store;
}

/**
 * The suite-wide store used by helpers that create several runtimes.
 *
 * @returns The shared live `PostgresStore`.
 */
export function sharedLiveStorage(): PostgresStore {
  sharedStore ??= createLiveStorage("as-graph-it-shared");
  return sharedStore;
}

/**
 * Builds a real `Mastra` runtime backed by the live stack.
 *
 * @param idPrefix - Store-id prefix for diagnostics.
 * @param workflows - Optional workflows registered on the runtime.
 * @returns The live `Mastra` runtime.
 */
export function liveMastra(
  idPrefix: string,
  workflows?: Record<string, unknown>
): Mastra {
  return new Mastra({
    storage: createLiveStorage(idPrefix),
    ...(workflows ? { workflows: workflows as never } : {}),
  });
}

/**
 * Closes every pool opened by this module.
 */
export async function closeLiveStores(): Promise<void> {
  const stores = [...openStores];
  openStores.clear();
  sharedStore = undefined;
  await Promise.all(
    stores.map(async (store) => {
      try {
        await store.close();
      } catch {
        // pool already closed
      }
    })
  );
}

/** Guard the schema identifier interpolated into cleanup SQL. */
function quotedSchema(schemaName: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(
      `Refusing to interpolate unexpected schema name '${schemaName}'`
    );
  }
  return `"${schemaName}"`;
}

/**
 * Deletes every row a suite created for the supplied run ids and workflow
 * names, in dependency order. Keeps suites rerunnable against shared tables.
 *
 * @param store - The live store (or any store with `db`).
 * @param runIds - Run ids created by the suite.
 * @param workflowNames - Workflow names created by the suite.
 */
export async function purgeLiveRuns(
  store: PostgresStore,
  runIds: string[],
  workflowNames: string[] = []
): Promise<void> {
  const schema = quotedSchema(livePostgresConfig()?.schemaName ?? LIVE_SCHEMA);
  const del = async (table: string, column: string) => {
    if (runIds.length === 0) return;
    await store.db.none(
      `DELETE FROM ${schema}.${table} WHERE "${column}" = ANY($1::text[])`,
      [runIds]
    );
  };
  await del("mastra_workflow_run_owners", "runId");
  await del("mastra_scorers", "runId");
  await del("mastra_ai_spans", "runId");
  await del("mastra_memory_run_fences", "runId");
  if (runIds.length > 0) {
    await store.db.none(
      `DELETE FROM ${schema}.mastra_workflow_snapshot WHERE run_id = ANY($1::text[])`,
      [runIds]
    );
  }
  if (workflowNames.length > 0) {
    await store.db.none(
      `DELETE FROM ${schema}.mastra_workflow_snapshot WHERE workflow_name = ANY($1::text[])`,
      [workflowNames]
    );
  }
}

/**
 * Deletes the memory rows a suite created for the supplied threads/resources.
 *
 * @param store - The live store.
 * @param threadIds - Thread ids created by the suite.
 * @param resourceIds - Resource ids created by the suite.
 */
export async function purgeLiveMemory(
  store: PostgresStore,
  threadIds: string[],
  resourceIds: string[] = []
): Promise<void> {
  const schema = quotedSchema(livePostgresConfig()?.schemaName ?? LIVE_SCHEMA);
  if (threadIds.length > 0) {
    await store.db.none(
      `DELETE FROM ${schema}.mastra_messages WHERE thread_id = ANY($1::text[])`,
      [threadIds]
    );
    await store.db.none(
      `DELETE FROM ${schema}.mastra_thread_state WHERE "threadId" = ANY($1::text[])`,
      [threadIds]
    );
    await store.db.none(
      `DELETE FROM ${schema}.mastra_observational_memory WHERE "threadId" = ANY($1::text[])`,
      [threadIds]
    );
    await store.db.none(
      `DELETE FROM ${schema}.mastra_threads WHERE id = ANY($1::text[])`,
      [threadIds]
    );
  }
  if (resourceIds.length > 0) {
    await store.db.none(
      `DELETE FROM ${schema}.mastra_resources WHERE id = ANY($1::text[])`,
      [resourceIds]
    );
  }
}

/**
 * Counts durable as-graph rows matching a column/value set, proving the test
 * exercised Postgres rather than a silent in-memory fallback.
 *
 * @param table - One of the five bootstrap tables.
 * @param column - A column on that table.
 * @param values - Values matched with `= ANY`.
 * @returns The matching row count.
 */
export async function liveAsGraphCount(
  table:
    | "graph_workflow"
    | "graph_run"
    | "graph_run_event"
    | "graph_node"
    | "graph_value",
  column: string,
  values: string[]
): Promise<number> {
  const options = liveAsGraphDataSourceOptions();
  if (!options) return 0;
  const schema = process.env["GRAPH_IT_POSTGRES_SCHEMA"]?.trim() || "asgraph";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(
      `Refusing to interpolate unexpected schema name '${schema}'`
    );
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(column)) {
    throw new Error(
      `Refusing to interpolate unexpected column name '${column}'`
    );
  }
  const { DataSource } = await import("typeorm");
  const dataSource = new DataSource(options);
  await dataSource.initialize();
  try {
    const rows = (await dataSource.query(
      `SELECT count(*)::int AS count FROM "${schema}".${table} WHERE "${column}" = ANY($1::text[])`,
      [values]
    )) as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  } finally {
    await dataSource.destroy();
  }
}

/**
 * Deletes the durable as-graph rows a suite created for the supplied workflow
 * ids from the `asgraph` schema.
 *
 * @param workflowIds - Workflow ids created by the suite.
 */
export async function purgeAsGraphWorkflows(
  workflowIds: string[]
): Promise<void> {
  if (workflowIds.length === 0) return;
  const options = liveAsGraphDataSourceOptions();
  if (!options) return;
  const schema = process.env["GRAPH_IT_POSTGRES_SCHEMA"]?.trim() || "asgraph";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(
      `Refusing to interpolate unexpected schema name '${schema}'`
    );
  }
  const { DataSource } = await import("typeorm");
  const dataSource = new DataSource(options);
  await dataSource.initialize();
  try {
    for (const table of [
      "graph_run_event",
      "graph_run",
      "graph_value",
      "graph_workflow",
    ]) {
      await dataSource.query(
        `DELETE FROM "${schema}".${table} WHERE "workflowId" = ANY($1::text[])`,
        [workflowIds]
      );
    }
  } finally {
    await dataSource.destroy();
  }
}

/**
 * Reads a single count from the live stack.
 *
 * @param store - The live store.
 * @param sql - A `SELECT count(*)::int AS count ...` statement.
 * @param values - Bound values.
 * @returns The count.
 */
export async function liveCount(
  store: PostgresStore,
  sql: string,
  values: unknown[] = []
): Promise<number> {
  const row = await store.db.one<{ count: number }>(sql, values);
  return Number(row.count);
}
