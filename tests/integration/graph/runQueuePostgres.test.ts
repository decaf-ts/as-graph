/**
 * @module as-graph/tests/integration/graph/runQueuePostgres
 * @summary api/worker split with the core TaskEngine queue in the durable
 * Postgres lane's `tasks` table, and the Dragonfly run bus.
 * @description The durable adapter maps the core task models
 * (`includeTaskModels`); its `url`-only connection still gives the TypeORM
 * adapter an operation user (`createdBy`/`updatedBy`).
 */
import { jest, describe, it, beforeAll } from "@jest/globals";
import { createTypeormGraphAdapter } from "../../../src/typeorm";
import { assertDistributedRuns } from "./distributedRunHarness";

jest.setTimeout(120000);

const DRAGONFLY = process.env["GRAPH_IT_DRAGONFLY_URL"];
const POSTGRES = process.env["GRAPH_IT_POSTGRES_URL"];
const live = DRAGONFLY && POSTGRES ? describe : describe.skip;

live("distributed runs with the TaskEngine queue on Postgres", () => {
  let adapter: unknown;

  beforeAll(async () => {
    adapter = await createTypeormGraphAdapter({
      dataSource: {
        type: "postgres",
        url: POSTGRES,
        schema: process.env["GRAPH_IT_POSTGRES_SCHEMA"] ?? "asgraph",
        synchronize: false,
      },
      includeTaskModels: true,
    });
  });

  it("TaskEngine on Postgres", async () => {
    const { TaskEngineGraphRunQueue } = await import(
      "../../../src/engine/runs/queue/TaskEngineGraphRunQueue"
    );
    await assertDistributedRuns(
      DRAGONFLY as string,
      async () => new TaskEngineGraphRunQueue({ adapter: adapter as never, pollMsIdle: 100 })
    );
  });
});
