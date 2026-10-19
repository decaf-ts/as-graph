/**
 * @module as-graph/tests/integration/graph/nodes/storage/redisNode
 * @summary SAA-1032: real-service integration coverage for the
 * `core.storage.redis` node kind.
 * @description Executes every documented Redis operation against the Docker
 * Redis instance, asserting the returned values/counts and the prefixed key
 * scoping. Uses a process-unique prefix so the suite never touches foreign
 * keys.
 */
import { describe, it, expect, afterAll } from "@jest/globals";
import { RedisAdapter } from "@decaf-ts/integrations/redis";
import { RedisNode } from "../../../../../src/node/storage/redis/node";
import {
  ENDPOINTS,
  runNode,
  uniqueName,
} from "../real-service-support";

jest.setTimeout(60000);

const kind = "core.storage.redis";
const prefix = uniqueName("saa1032-redis");
const base = {
  host: ENDPOINTS.redis.host,
  port: ENDPOINTS.redis.port,
  prefix,
};

afterAll(async () => {
  const adapter = new RedisAdapter(
    { host: ENDPOINTS.redis.host, port: ENDPOINTS.redis.port },
    `${prefix}-cleanup`
  );
  await adapter.initialize();
  const keys = await adapter.client.keys(`${prefix}:*`);
  if (keys.length) await adapter.client.del(...keys);
  await adapter.shutdown();
});

describe("core.storage.redis (real Redis)", () => {
  it("sets and gets a JSON value in the prefixed namespace", async () => {
    const set = await runNode(RedisNode, kind, {
      ...base,
      operation: "set",
      key: "greeting",
      value: { hello: "world" },
    });
    expect(set.result).toBe("OK");

    const get = await runNode(RedisNode, kind, {
      ...base,
      operation: "get",
      key: "greeting",
    });
    expect(get.result).toEqual({ hello: "world" });
  });

  it("honours a TTL and reports the remaining ttl", async () => {
    await runNode(RedisNode, kind, {
      ...base,
      operation: "set",
      key: "ephemeral",
      value: "short",
      ttlSeconds: 30,
    });

    const adapter = new RedisAdapter(
      { host: ENDPOINTS.redis.host, port: ENDPOINTS.redis.port },
      `${prefix}-ttl`
    );
    await adapter.initialize();
    const ttl = await adapter.client.ttl(`${prefix}:ephemeral`);
    await adapter.shutdown();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it("increments, deletes and reports counts", async () => {
    const first = await runNode(RedisNode, kind, {
      ...base,
      operation: "incr",
      key: "counter",
    });
    const second = await runNode(RedisNode, kind, {
      ...base,
      operation: "incr",
      key: "counter",
    });
    expect(first.result).toBe(1);
    expect(second.result).toBe(2);

    const deleted = await runNode(RedisNode, kind, {
      ...base,
      operation: "delete",
      key: "counter",
    });
    expect(deleted.result).toBe(1);
    expect(deleted.count).toBe(1);
  });

  it("pushes and pops both list ends", async () => {
    const right = await runNode(RedisNode, kind, {
      ...base,
      operation: "rpush",
      key: "queue",
      value: "right",
    });
    expect(right.result).toBe(1);

    const left = await runNode(RedisNode, kind, {
      ...base,
      operation: "lpush",
      key: "queue",
      value: "left",
    });
    expect(left.result).toBe(2);

    const length = await runNode(RedisNode, kind, {
      ...base,
      operation: "llen",
      key: "queue",
    });
    expect(length.result).toBe(2);

    const poppedLeft = await runNode(RedisNode, kind, {
      ...base,
      operation: "lpop",
      key: "queue",
    });
    const poppedRight = await runNode(RedisNode, kind, {
      ...base,
      operation: "rpop",
      key: "queue",
    });
    expect(poppedLeft.result).toBe("left");
    expect(poppedRight.result).toBe("right");
  });

  it("lists keys under the configured prefix", async () => {
    await runNode(RedisNode, kind, {
      ...base,
      operation: "set",
      key: "listed",
      value: 1,
    });
    const listed = await runNode(RedisNode, kind, {
      ...base,
      operation: "keys",
      pattern: "*listed",
    });
    expect(listed.result).toEqual([`${prefix}:listed`]);
    expect(listed.count).toBe(1);
  });

  it("publishes to a channel and reports the receiver count", async () => {
    const published = await runNode(RedisNode, kind, {
      ...base,
      operation: "publish",
      channel: `${prefix}-channel`,
      value: "payload",
    });
    expect(published.result).toBe(0);
  });

  it("returns server info", async () => {
    const info = await runNode(RedisNode, kind, {
      ...base,
      operation: "info",
      section: "server",
    });
    expect(typeof info.result).toBe("string");
    expect(String(info.result)).toContain("redis_version");
  });

  it("fails fast when an operation that needs a key has none", async () => {
    await expect(
      runNode(RedisNode, kind, { ...base, operation: "get" })
    ).rejects.toMatchObject({ graphCode: "GRAPH_REDIS_KEY_REQUIRED" });
  });
});
