/**
 * @module as-graph/tests/integration/graph/nodes/storage/databaseNodes
 * @summary SAA-1032: real-service integration coverage for the
 * `core.storage.postgres`, `core.storage.mySql` and
 * `core.storage.microsoftSql` node kinds.
 * @description Drives the production node instantiation/execution contract
 * against the Docker Postgres, MySQL and SQL Server instances supplied with the
 * issue. Each suite creates a real table, executes parameterized DDL/DML/read
 * statements through the node, and proves the password never reaches the node
 * output.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { Client as PgClient } from "pg";
import mysql from "mysql2/promise";
import sql from "mssql";
import { PostgresNode } from "../../../../../src/node/storage/database/postgres/node";
import { MySqlNode } from "../../../../../src/node/storage/database/mysql/node";
import { MicrosoftSqlNode } from "../../../../../src/node/storage/database/mssql/node";
import {
  ENDPOINTS,
  clearCredentials,
  credential,
  errorCodeOf,
  runNode,
  setCredential,
  uniqueName,
} from "../real-service-support";

jest.setTimeout(90000);

interface DataSourceOptionsProbe {
  dataSourceOptions(
    host: string,
    port: number,
    database: string,
    username: string,
    password: string | undefined
  ): { ssl?: unknown };
}

function postgresOptions(parameters: Record<string, unknown>) {
  const node = PostgresNode.instantiate(parameters) as unknown as DataSourceOptionsProbe;
  return node.dataSourceOptions("db.example.test", 5432, "app", "user", "pass");
}

describe("core.storage.postgres TLS posture (SAA-1044 F3)", () => {
  it("verifies the server certificate by default when ssl is enabled", () => {
    const options = postgresOptions({ ssl: true });
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
  });

  it("rejects self-signed certificates unless acceptSelfSigned is explicitly set", () => {
    expect(postgresOptions({ ssl: true, acceptSelfSigned: true }).ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(
      postgresOptions({ ssl: true, acceptSelfSigned: false }).ssl
    ).toEqual({ rejectUnauthorized: true });
  });

  it("leaves TLS disabled when ssl is off, even with acceptSelfSigned", () => {
    expect(postgresOptions({ ssl: false }).ssl).toBe(false);
    expect(
      postgresOptions({ ssl: false, acceptSelfSigned: true }).ssl
    ).toBe(false);
  });
});

describe("core.storage.postgres (real Postgres)", () => {
  const kind = "core.storage.postgres";
  const envName = "it-saa1032-PG";
  const table = uniqueName("saa1032_pg").replace(/-/g, "_");
  const credentials = credential(envName, "postgres");
  const parameters = {
    host: ENDPOINTS.postgres.host,
    port: ENDPOINTS.postgres.port,
    database: ENDPOINTS.postgres.database,
    username: ENDPOINTS.postgres.username,
  };

  beforeAll(() => {
    setCredential(envName, ENDPOINTS.postgres.password);
  });

  afterAll(async () => {
    clearCredentials(envName);
    const client = new PgClient({
      host: ENDPOINTS.postgres.host,
      port: ENDPOINTS.postgres.port,
      user: ENDPOINTS.postgres.username,
      password: ENDPOINTS.postgres.password,
      database: ENDPOINTS.postgres.database,
    });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS ${table}`);
    await client.end();
  });

  it("creates a table, inserts with bound parameters and reads the row back", async () => {
    await runNode(
      PostgresNode,
      kind,
      {
        ...parameters,
        sql: `CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY, name text NOT NULL)`,
      },
      {},
      credentials
    );

    await runNode(
      PostgresNode,
      kind,
      {
        ...parameters,
        sql: `INSERT INTO ${table} (id, name) VALUES ($1, $2)`,
        parameters: [1, "alpha"],
      },
      {},
      credentials
    );

    const read = await runNode(
      PostgresNode,
      kind,
      {
        ...parameters,
        sql: `SELECT id, name FROM ${table} WHERE name = $1`,
        parameters: ["alpha"],
      },
      {},
      credentials
    );

    expect(read.result).toEqual([{ id: 1, name: "alpha" }]);
    expect(read.rows).toEqual([{ id: 1, name: "alpha" }]);
    expect(read.rowCount).toBe(1);
    expect(JSON.stringify(read)).not.toContain(ENDPOINTS.postgres.password);
  });

  it("binds the value input when parameters are omitted", async () => {
    await runNode(
      PostgresNode,
      kind,
      {
        ...parameters,
        sql: `CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY, name text NOT NULL)`,
      },
      {},
      credentials
    );

    await runNode(
      PostgresNode,
      kind,
      {
        ...parameters,
        sql: `INSERT INTO ${table} (id, name) VALUES ($1, $2)`,
      },
      { value: [2, "fallback-value"] },
      credentials
    );

    const read = await runNode(
      PostgresNode,
      kind,
      {
        ...parameters,
        sql: `SELECT id, name FROM ${table} WHERE id = $1`,
      },
      { value: [2] },
      credentials
    );

    expect(read.result).toEqual([{ id: 2, name: "fallback-value" }]);
    expect(read.rows).toEqual([{ id: 2, name: "fallback-value" }]);
    expect(read.rowCount).toBe(1);
  });

  it("fails fast when the SQL statement is missing", async () => {
    await expect(
      runNode(PostgresNode, kind, parameters, {}, credentials)
    ).rejects.toMatchObject({ graphCode: "GRAPH_DATABASE_SQL_REQUIRED" });
  });
});

describe("core.storage.mySql (real MySQL)", () => {
  const kind = "core.storage.mySql";
  const envName = "it-saa1032-MYSQL";
  const table = uniqueName("saa1032_mysql").replace(/-/g, "_");
  const credentials = credential(envName, "mysql");
  const parameters = {
    host: ENDPOINTS.mysql.host,
    port: ENDPOINTS.mysql.port,
    database: ENDPOINTS.mysql.database,
    username: ENDPOINTS.mysql.username,
  };

  beforeAll(() => {
    setCredential(envName, ENDPOINTS.mysql.password);
  });

  afterAll(async () => {
    clearCredentials(envName);
    const connection = await mysql.createConnection({
      host: ENDPOINTS.mysql.host,
      port: ENDPOINTS.mysql.port,
      user: ENDPOINTS.mysql.username,
      password: ENDPOINTS.mysql.password,
      database: ENDPOINTS.mysql.database,
    });
    await connection.query(`DROP TABLE IF EXISTS ${table}`);
    await connection.end();
  });

  it("creates a table, inserts with bound parameters and reads the row back", async () => {
    await runNode(
      MySqlNode,
      kind,
      {
        ...parameters,
        sql: `CREATE TABLE IF NOT EXISTS ${table} (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL)`,
      },
      {},
      credentials
    );

    await runNode(
      MySqlNode,
      kind,
      {
        ...parameters,
        sql: `INSERT INTO ${table} (id, name) VALUES (?, ?)`,
        parameters: [7, "beta"],
      },
      {},
      credentials
    );

    const read = await runNode(
      MySqlNode,
      kind,
      {
        ...parameters,
        sql: `SELECT id, name FROM ${table} WHERE id = ?`,
        parameters: [7],
      },
      {},
      credentials
    );

    expect(read.result).toEqual([{ id: 7, name: "beta" }]);
    expect(read.rowCount).toBe(1);
    expect(JSON.stringify(read)).not.toContain(ENDPOINTS.mysql.password);
  });

  it("surfaces a real SQL error through GRAPH_DATABASE_QUERY_FAILED", async () => {
    try {
      await runNode(
        MySqlNode,
        kind,
        { ...parameters, sql: "SELECT * FROM saa1032_table_that_does_not_exist" },
        {},
        credentials
      );
      throw new Error("expected the node to fail");
    } catch (error) {
      expect(errorCodeOf(error)).toBe("GRAPH_DATABASE_QUERY_FAILED");
    }
  });
});

describe("core.storage.microsoftSql (real SQL Server)", () => {
  const kind = "core.storage.microsoftSql";
  const envName = "it-saa1032-MSSQL";
  const table = uniqueName("saa1032_mssql").replace(/-/g, "_");
  const credentials = credential(envName, "mssql");
  const parameters = {
    host: ENDPOINTS.mssql.host,
    port: ENDPOINTS.mssql.port,
    database: ENDPOINTS.mssql.database,
    username: ENDPOINTS.mssql.username,
  };

  beforeAll(() => {
    setCredential(envName, ENDPOINTS.mssql.password);
  });

  afterAll(async () => {
    clearCredentials(envName);
    const pool = await sql.connect({
      server: ENDPOINTS.mssql.host,
      port: ENDPOINTS.mssql.port,
      user: ENDPOINTS.mssql.username,
      password: ENDPOINTS.mssql.password,
      database: ENDPOINTS.mssql.database,
      options: { encrypt: false, trustServerCertificate: true },
    });
    await pool.request().query(`DROP TABLE IF EXISTS ${table}`);
    await pool.close();
  });

  it("creates a table, inserts with bound parameters and reads the row back", async () => {
    await runNode(
      MicrosoftSqlNode,
      kind,
      {
        ...parameters,
        sql: `CREATE TABLE ${table} (id INT PRIMARY KEY, name NVARCHAR(64) NOT NULL)`,
      },
      {},
      credentials
    );

    await runNode(
      MicrosoftSqlNode,
      kind,
      {
        ...parameters,
        sql: `INSERT INTO ${table} (id, name) VALUES (@0, @1)`,
        parameters: [3, "gamma"],
      },
      {},
      credentials
    );

    const read = await runNode(
      MicrosoftSqlNode,
      kind,
      {
        ...parameters,
        sql: `SELECT id, name FROM ${table} WHERE id = @0`,
        parameters: [3],
      },
      {},
      credentials
    );

    expect(read.result).toEqual([{ id: 3, name: "gamma" }]);
    expect(read.rowCount).toBe(1);
    expect(JSON.stringify(read)).not.toContain(ENDPOINTS.mssql.password);
  });

  it("requires host, database and username", async () => {
    await expect(
      runNode(
        MicrosoftSqlNode,
        kind,
        { sql: "SELECT 1 AS n", database: "master", username: "sa" },
        {},
        credentials
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_DATABASE_CONNECTION_REQUIRED" });
  });
});
