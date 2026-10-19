/**
 * @module as-graph/nodes/storage/database/postgres
 * @summary PostgreSQL storage node declaration (Stage 3a).
 * @description PostgreSQL — run a SQL statement against a Postgres server. Fixes the `postgres` TypeORM driver (default port 5432) and accepts an optional `postgres`-type credential that supplies the connection password through a `GRAPH_CREDENTIAL_*` environment variable. Connection, SSL, parameter binding, result normalization, and teardown behaviour are inherited from `DatabaseNode`.
 */
import { model } from "@decaf-ts/decorator-validation";
import { node } from "../../../../shared/graph";
import { DatabaseNode, type DatabaseDriver } from "../base";

/**
 * SQL database node for the corresponding driver; configuration and behaviour come from `DatabaseNode`.
 */
@node("core.storage.postgres", {
  kind: "core.storage.postgres",
  category: "Storage",
  color: "#336791",
  icon: "ti-database",
  width: 96,
  height: 96,
  labels: ["storage", "database", "postgres", "sql"],
  metadata: {
    title: "graph.node.storage.postgres.name",
    description: "graph.node.storage.postgres.description",
  },
})
@model()
export class PostgresNode extends DatabaseNode {
  protected readonly driver: DatabaseDriver = "postgres";
  protected readonly credentialType = "postgres";
}
