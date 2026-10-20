/**
 * @module as-graph/nodes/storage/database/mssql
 * @summary Microsoft SQL Server storage node declaration (Stage 3a).
 * @description Microsoft SQL Server — run a SQL statement against an MSSQL server. Fixes the `mssql` TypeORM driver (default port 1433) and accepts an optional `mssql`-type credential that supplies the connection password through the ctx-bound node credential resolver. Connection, SSL, parameter binding, result normalization (including `recordsets` flattening), and teardown behaviour are inherited from `DatabaseNode`.
 */
import { model } from "@decaf-ts/decorator-validation";
import { node } from "../../../../shared/graph";
import { DatabaseNode, type DatabaseDriver } from "../base";

/**
 * SQL database node for the corresponding driver; configuration and behaviour come from `DatabaseNode`.
 */
@node("core.storage.microsoftSql", {
  kind: "core.storage.microsoftSql",
  category: "Storage",
  color: "#cc2927",
  icon: "ti-database",
  width: 96,
  height: 96,
  labels: ["storage", "database", "mssql", "sqlserver", "sql"],
  metadata: {
    title: "graph.node.storage.microsoft_sql.name",
    description: "graph.node.storage.microsoft_sql.description",
  },
})
@model()
export class MicrosoftSqlNode extends DatabaseNode {
  protected readonly driver: DatabaseDriver = "mssql";
  protected readonly credentialType = "mssql";
}
