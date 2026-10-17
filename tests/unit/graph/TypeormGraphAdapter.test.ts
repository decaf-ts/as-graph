/**
 * @module as-graph/tests/unit/graph/TypeormGraphAdapter
 * @summary SAA-926 §6.4 acceptance: the durable as-graph adapter is
 * fail-closed on a non-Postgres driver and on runtime schema mutation
 * (`synchronize: true`), because the `asgraph` schema is owned by the stack's
 * bootstrap migrations and the runtime role is least-privilege.
 * @description These assertions exercise the production guard before any
 * connection is opened: no live database is required. The live round-trip over
 * the bootstrap DDL is covered by
 * `tests/integration/graph/TypeormGraphAdapterPostgres.test.ts`.
 */
import { describe, it, expect } from "@jest/globals";
import type { DataSourceOptions } from "typeorm";
import { createTypeormGraphAdapter } from "../../../src/typeorm";

describe("createTypeormGraphAdapter fail-closed contract (SAA-926 §6.4)", () => {
  it("rejects a missing data source", async () => {
    await expect(
      createTypeormGraphAdapter({} as never)
    ).rejects.toThrow(/type: "postgres"/);
  });

  it.each(["sqlite", "better-sqlite3", "mysql", "mariadb", "oracle", "mssql"])(
    "rejects the non-postgres driver '%s'",
    async (type) => {
      await expect(
        createTypeormGraphAdapter({
          dataSource: { type, synchronize: false } as unknown as DataSourceOptions,
        })
      ).rejects.toThrow(/type: "postgres"/);
    }
  );

  it("rejects runtime schema mutation with synchronize: true", async () => {
    await expect(
      createTypeormGraphAdapter({
        dataSource: {
          type: "postgres",
          host: "127.0.0.1",
          username: "mastra_app",
          password: "not-used",
          database: "decaf",
          schema: "asgraph",
          synchronize: true,
        },
      })
    ).rejects.toThrow(/synchronize: false/);
  });

  it("names the bootstrap-owned schema in the synchronize rejection", async () => {
    await expect(
      createTypeormGraphAdapter({
        dataSource: {
          type: "postgres",
          host: "127.0.0.1",
          username: "mastra_app",
          password: "not-used",
          database: "decaf",
          schema: "asgraph",
          synchronize: true,
        },
      })
    ).rejects.toThrow(/bootstrap migrations/);
  });
});
