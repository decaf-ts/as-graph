/**
 * @module as-graph/nodes/storage/database/base
 * @summary Shared behaviour for the SQL database node kinds (postgres, mySql, microsoftSql).
 * @description `DatabaseNode` is the single implementation behind the three
 * Stage 3a SQL database node kinds: each leaf fixes a TypeORM driver, a default
 * port, and a credential type, and this base class owns the rest. Execution
 * opens a throwaway `TypeORMAdapter` (a uniquely aliased adapter per run, always
 * unregistered in `finally`), sends the configured SQL statement with optional
 * bound parameters, and normalizes the driver-specific raw result into the
 * `result`/`rows`/`rowCount` outputs. Credentials are optional at the base
 * level (the password may not be needed); they resolve through the ctx-bound
 * node credential resolver. Connection options honor
 * the `ssl` toggle with per-driver TLS shapes. Postgres TLS always verifies the
 * server certificate (`rejectUnauthorized: true`) unless the explicit
 * `acceptSelfSigned` toggle is enabled; no schema synchronization is ever
 * performed (`synchronize: false`).
 */
import { required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import type { DataSourceOptions } from "typeorm";
import { TypeORMAdapter } from "@decaf-ts/for-typeorm";
import { Adapter, Context } from "@decaf-ts/core";
import { input, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import {
  asBoolean,
  asNumber,
  asRecord,
  asStringArray,
  resolveNodeCredential,
} from "../support";
import { credentialSecret } from "../../credentials";

/** Inputs accepted by the SQL database nodes (the optional `value` array feeds bound parameters). */
export type DatabaseNodeInput = Record<string, unknown>;

/** Outputs produced by the SQL database nodes: the result rows and affected-row count. */
export interface DatabaseNodeOutput {
  result: unknown[];
  rows?: unknown[];
  rowCount?: number;
}

/** Default TCP ports per supported driver. */
const DEFAULT_PORTS = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
} as const;

/** TypeORM driver keys supported by the database node kinds. */
export type DatabaseDriver = keyof typeof DEFAULT_PORTS;

/**
 * Base class for the SQL database node kinds (postgres, mySql, microsoftSql).
 *
 * Leaf subclasses fix {@link DatabaseNode.driver} and
 * {@link DatabaseNode.credentialType}; everything else — connection assembly,
 * parameter binding, result normalization, and adapter teardown — lives here.
 */
export abstract class DatabaseNode extends GraphNode<
  DatabaseNodeInput,
  DatabaseNodeOutput
> {
  /** TypeORM driver this node connects with. */
  protected abstract readonly driver: DatabaseDriver;
  /** Credential type accepted by this node's optional credential reference. */
  protected abstract readonly credentialType: string;

  /**
   * Assembles the TypeORM `DataSourceOptions` for this node's driver.
   *
   * Postgres gets `ssl: { rejectUnauthorized: true }` when enabled and rejects
   * self-signed certificates unless the explicit `acceptSelfSigned` toggle is
   * set. MySQL enables TLS with an empty options object, and MSSQL encrypts
   * while trusting the server certificate when SSL is off.
   *
   * @param host - Resolved database host.
   * @param port - Resolved database port.
   * @param database - Resolved database name.
   * @param username - Resolved connection username.
   * @param password - Resolved password, when a credential was available.
   * @returns The driver-specific data source options.
   */
  protected dataSourceOptions(
    host: string,
    port: number,
    database: string,
    username: string,
    password: string | undefined
  ): DataSourceOptions {
    const ssl = asBoolean(this.ssl, false);
    const acceptSelfSigned = asBoolean(this.acceptSelfSigned, false);
    const base = {
      host,
      port,
      database,
      username,
      password,
      entities: [],
      synchronize: false,
    };
    if (this.driver === "postgres") {
      return {
        ...base,
        type: "postgres",
        ssl: ssl ? { rejectUnauthorized: !acceptSelfSigned } : false,
      } as DataSourceOptions;
    }
    if (this.driver === "mysql") {
      return {
        ...base,
        type: "mysql",
        ssl: ssl ? {} : undefined,
      } as DataSourceOptions;
    }
    return {
      ...base,
      type: "mssql",
      options: { encrypt: ssl, trustServerCertificate: !ssl },
    } as DataSourceOptions;
  }

  /**
   * Sends the configured SQL statement against a throwaway adapter and emits
   * the normalized result.
   *
   * A fresh `TypeORMAdapter` is created per execution (uniquely aliased), so
   * no connection state survives the node run; the adapter is shut down and
   * unregistered in `finally` even when the query fails. When no `parameters`
   * are configured and the `value` input is an array, the input rows are bound
   * instead.
   *
   * @param request - The execution request carrying resolved credentials and the optional `value` input.
    * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns The result rows under `result` (and `rows`), plus `rowCount` where the driver reports affected rows.
   * @throws {GraphExecutionError} with code `GRAPH_DATABASE_SQL_REQUIRED` when no `sql` is configured,
   *   `GRAPH_DATABASE_CONNECTION_REQUIRED` when host, database, or username is blank,
   *   `GRAPH_CREDENTIAL_*` codes from credential resolution, and
   *   `GRAPH_DATABASE_QUERY_FAILED` when adapter setup or the query itself fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<DatabaseNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const nodeName = this.constructor.name;
    const sql = this.sql?.trim();
    if (!sql) {
      throw new GraphExecutionError(
        `${nodeName} node requires a SQL statement`,
        "GRAPH_DATABASE_SQL_REQUIRED"
      );
    }
    const host = this.host?.trim();
    const database = this.database?.trim();
    const username = this.username?.trim();
    if (!host || !database || !username) {
      throw new GraphExecutionError(
        `${nodeName} node requires host, database, and username`,
        "GRAPH_DATABASE_CONNECTION_REQUIRED"
      );
    }
    const password = credentialSecret(
      await resolveNodeCredential(
        context,
        request.credentials,
        this.credentialType,
        false,
        nodeName
      ),
      ["password", "secret", "token"],
      nodeName
    );
    const parameters =
      asStringArray(this.parameters) ??
      (Array.isArray(request.inputs["value"]) ? request.inputs["value"] : []);

    const alias = `as-graph-${this.driver}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const adapter = new TypeORMAdapter(
      this.dataSourceOptions(
        host,
        asNumber(this.port) ?? DEFAULT_PORTS[this.driver],
        database,
        username,
        password
      ),
      alias
    );
    const adapterContext = new Context();
    try {
      await adapter.initialize(adapterContext);
      const raw = await adapter.raw<unknown, true>(
        { query: sql, values: parameters },
        true,
        adapterContext
      );
      const { rows, rowCount } = normalizeDatabaseResult(raw);
      return { result: rows, rows, rowCount };
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `${nodeName} node query failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_DATABASE_QUERY_FAILED",
        { driver: this.driver }
      );
    } finally {
      await adapter.shutdown().catch(() => undefined);
      Adapter.unregister(alias);
    }
  }

  /** Database server host. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.host.label",
    type: "string",
  })
  @input({ handle: "host", userControlled: true })
  host!: string;

  /** Optional TCP port; falls back to the driver default (5432/3306/1433). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.port.label",
    type: "number",
  })
  @input({ handle: "port", userControlled: true })
  port?: number;

  /** Database (or schema) name to connect to. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.database.label",
    type: "string",
  })
  @input({ handle: "database", userControlled: true })
  database!: string;

  /** Connection username. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.username.label",
    type: "string",
  })
  @input({ handle: "username", userControlled: true })
  username!: string;

  /** Whether TLS is enabled; interpreted per driver (see `dataSourceOptions`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.ssl.label",
    type: "boolean",
  })
  @input({ handle: "ssl", userControlled: true })
  ssl: boolean = false;

  /**
   * Accept self-signed certificates for Postgres TLS. Defaults to `false`,
   * which verifies the server certificate (`rejectUnauthorized: true`); only
   * enable this for a known development database.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.acceptSelfSigned.label",
    type: "boolean",
  })
  @input({ handle: "acceptSelfSigned", userControlled: true })
  acceptSelfSigned: boolean = false;

  /** SQL statement to execute. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.sql.label",
    type: "textarea",
  })
  @input({ handle: "sql", userControlled: true })
  sql!: string;

  /** Optional positional bind parameters for the SQL statement. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.parameters.label",
    type: "array",
  })
  @input({ handle: "parameters", userControlled: true })
  parameters?: unknown[];

  /** Optional `value` input rows used as bind parameters when `parameters` is unset. */
  @input({ handle: "value" })
  value?: unknown;

  /** Output rows (the normalized query result). */
  @required()
  @output({ handle: "result", type: "array" })
  result!: unknown[];

  /** Output alias carrying the same rows as `result`. */
  @output({ handle: "rows", type: "array" })
  rows?: unknown[];

  /** Affected-row count when the driver reports one. */
  @output({ handle: "rowCount", type: "number" })
  rowCount?: number;
}

/**
 * Normalizes a driver-specific raw query result into `{ rows, rowCount }`.
 *
 * Handles the result shapes reported by the supported drivers: plain row
 * arrays (postgres/mysql), MSSQL `recordsets` with summed `rowsAffected`,
 * `rows`/`rowCount` records, single `recordset` arrays, `data`/`count`
 * records, and bare `affectedRows` counts (no rows).
 *
 * @param raw - The raw adapter query result.
 * @returns The normalized rows and row count.
 */
function normalizeDatabaseResult(raw: unknown): {
  rows: unknown[];
  rowCount: number;
} {
  if (Array.isArray(raw)) {
    return { rows: raw, rowCount: raw.length };
  }
  const record = asRecord(raw);
  if (!record) return { rows: [], rowCount: 0 };
  if (Array.isArray(record["recordsets"])) {
    const rows = (record["recordsets"] as unknown[][]).flat();
    const affected = record["rowsAffected"];
    const rowCount = Array.isArray(affected)
      ? affected.reduce((sum, value) => sum + Number(value || 0), 0)
      : rows.length;
    return { rows, rowCount };
  }
  if (Array.isArray(record["rows"])) {
    const rows = record["rows"] as unknown[];
    return {
      rows,
      rowCount: asNumber(record["rowCount"]) ?? rows.length,
    };
  }
  if (Array.isArray(record["recordset"])) {
    const rows = record["recordset"] as unknown[];
    return { rows, rowCount: rows.length };
  }
  if (Array.isArray(record["data"])) {
    const rows = record["data"] as unknown[];
    return { rows, rowCount: asNumber(record["count"]) ?? rows.length };
  }
  return { rows: [], rowCount: asNumber(record["affectedRows"]) ?? 0 };
}
