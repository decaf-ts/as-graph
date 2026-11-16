#!/usr/bin/env node
/* global require, process, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- plain Node script */
/**
 * Generates the as-graph bootstrap DDL from the same TypeORM entity metadata
 * the durable adapter runs on (`createTypeormGraphAdapter`), so the schema can
 * never drift from the models.
 *
 * Usage: node scripts/generate-asgraph-ddl.cjs <postgres-url-of-an-EMPTY-db> [output.sql] [schema]
 *   (`npm run ddl:asgraph -- <url>`; output defaults to
 *   `docker/sql/0001_asgraph_decaf_tables.sql`, the copy as-graph ships and
 *   applies — deployments take it from the package)
 *
 * The target database must be empty (TypeORM diffs against it); the script
 * creates the schema there, reads the "create everything" plan and prints it
 * as idempotent SQL (IF NOT EXISTS), without applying it.
 */
const { Client } = require("pg");
const { createTypeormGraphAdapter } = require("../lib/cjs/typeorm/index.cjs");

async function main() {
  const [
    url,
    output = require("node:path").join(__dirname, "..", "docker", "sql", "0001_asgraph_decaf_tables.sql"),
    schema = "asgraph",
  ] = process.argv.slice(2);
  if (!url) {
    throw new Error("usage: generate-asgraph-ddl.cjs <postgres-url> [output.sql] [schema]");
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.end();
  const adapter = await createTypeormGraphAdapter({
    dataSource: { type: "postgres", url, schema, synchronize: false },
    includeTaskModels: true,
  });
  const dataSource = adapter.getClient();
  if (!dataSource.isInitialized) await dataSource.initialize();
  const plan = await dataSource.driver.createSchemaBuilder().log();
  const statements = plan.upQueries
    .map((query) => query.query.trim())
    .map((sql) =>
      sql
        .replace(/^CREATE TABLE /, "CREATE TABLE IF NOT EXISTS ")
        .replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS ")
    );
  const out = [
    "-- 0001_asgraph_decaf_tables.sql",
    "-- Bootstrap DDL for the @decaf-ts/as-graph decaf tables, GENERATED from the",
    "-- TypeORM entity metadata of the durable adapter by",
    "-- `as-graph/scripts/generate-asgraph-ddl.cjs` — do not edit by hand;",
    "-- regenerate after a model change. `tests/integration/graph/",
    "-- TypeormGraphAdapterPostgres.test.ts` fails when a model and this schema",
    "-- disagree.",
    "--",
    "-- Tables: graph runs/events/workflows/nodes/values/data tables, the binary",
    "-- index (graph_binary, graph_binary_holder), tenant quotas, and the Decaf",
    "-- core TaskEngine tables (tasks, task_event) for GRAPH_RUN_QUEUE=task-engine.",
    "-- Shipped with @decaf-ts/as-graph (`docker/sql/`): applied by its own",
    "-- integration setup and by deployments' bootstrap migration (as the",
    "-- migrator role). Idempotent (IF NOT EXISTS).",
    "",
    `CREATE SCHEMA IF NOT EXISTS ${schema};`,
    `SET search_path = ${schema};`,
    "",
    ...statements.map((sql) => `${sql};`),
    "",
    "RESET search_path;",
    "",
  ];
  require("node:fs").writeFileSync(output, out.join("\n"));
  await dataSource.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
