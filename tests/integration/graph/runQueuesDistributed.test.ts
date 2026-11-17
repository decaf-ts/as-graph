/**
 * @module as-graph/tests/integration/graph/runQueuesDistributed
 * @summary api/worker split over real Dragonfly: the TaskEngine queue on the
 * integrations Redis adapter and the BullMQ queue, with the Dragonfly run bus.
 * @description See {@link assertDistributedRuns}. TaskEngine on Postgres runs
 * in `runQueuePostgres.test.ts` (the Postgres task models are flavoured
 * process-wide).
 */
import { jest, describe, it, afterAll } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import type { RedisAdapter } from "@decaf-ts/integrations/redis";
import { TaskEngineGraphRunQueue } from "../../../src/engine/runs/queue/TaskEngineGraphRunQueue";
import { BullMqGraphRunQueue } from "../../../src/engine/runs/queue/BullMqGraphRunQueue";
import { assertDistributedRuns } from "./distributedRunHarness";

jest.setTimeout(120000);

const DRAGONFLY = process.env["GRAPH_IT_DRAGONFLY_URL"];
const live = DRAGONFLY ? describe : describe.skip;

live("distributed runs over Dragonfly", () => {
  const prefix = `{graph-it-${randomUUID().slice(0, 8)}}`;
  let redisTasks: Promise<RedisAdapter> | undefined;

  afterAll(async () => {
    try {
      const client = createClient({ url: DRAGONFLY });
      try {
        await client.connect();
        for await (const keys of client.scanIterator({ MATCH: `*${prefix}*`, COUNT: 500 })) {
          const batch = ([] as string[]).concat(keys as unknown as string[]);
          if (batch.length) await client.del(batch);
        }
      } finally {
        if (client.isOpen) await client.quit();
      }
    } finally {
      // The queues borrow this shared adapter; their stop() leaves it open.
      await (await redisTasks)?.shutdown();
    }
  });

  it("TaskEngine on Dragonfly (integrations Redis adapter)", async () => {
    await assertDistributedRuns(DRAGONFLY as string, async () => {
      redisTasks ??= (async () => {
        const { RedisAdapter } = await import("@decaf-ts/integrations/redis");
        const adapter = new RedisAdapter({ url: DRAGONFLY, prefix }, `graph-it-tasks-${randomUUID()}`);
        try {
          await adapter.initialize();
        } catch (error) {
          await adapter.shutdown();
          throw error;
        }
        return adapter;
      })();
      return new TaskEngineGraphRunQueue({ adapter: (await redisTasks) as never, pollMsIdle: 100 });
    });
  });

  it("BullMQ on Dragonfly", async () => {
    await assertDistributedRuns(
      DRAGONFLY as string,
      async () => new BullMqGraphRunQueue({ url: DRAGONFLY as string, prefix, name: "graph-runs-it" })
    );
  });
});
