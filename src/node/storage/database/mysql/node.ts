/**
 * @module as-graph/nodes/storage/database/mysql
 * @summary MySQL storage node declaration (Stage 3a).
 * @description MySQL — run a SQL statement against a MySQL/MariaDB server. Fixes the `mysql` TypeORM driver (default port 3306) and accepts an optional `mysql`-type credential that supplies the connection password through a `GRAPH_CREDENTIAL_*` environment variable. Connection, SSL, parameter binding, result normalization, and teardown behaviour are inherited from `DatabaseNode`.
 */
import { model } from "@decaf-ts/decorator-validation";
import { node } from "../../../../shared/graph";
import { DatabaseNode, type DatabaseDriver } from "../base";

/**
 * SQL database node for the corresponding driver; configuration and behaviour come from `DatabaseNode`.
 */
@node("core.storage.mySql", {
  kind: "core.storage.mySql",
  category: "Storage",
  color: "#00758f",
  icon: "ti-database",
  width: 96,
  height: 96,
  labels: ["storage", "database", "mysql", "sql"],
  metadata: {
    title: "graph.node.storage.my_sql.name",
    description: "graph.node.storage.my_sql.description",
  },
})
@model()
export class MySqlNode extends DatabaseNode {
  protected readonly driver: DatabaseDriver = "mysql";
  protected readonly credentialType = "mysql";
}
