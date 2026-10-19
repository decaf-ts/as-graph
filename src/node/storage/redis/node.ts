/**
 * @module as-graph/nodes/storage/redis
 * @summary Redis storage node declaration (Stage 3a).
 * @description Redis — run a single key-value, list, pub/sub, or info
 * operation against a Redis server. Twelve operations are supported (`get`,
 * `set`, `delete`, `incr`, `keys`, `llen`, `lpop`, `rpop`, `lpush`, `rpush`,
 * `publish`, `info`); every key- or channel-based operation is scoped by the
 * optional `prefix` (`prefix:key`). Values are JSON-decoded on read and
 * JSON-encoded on write (strings pass through, null/undefined encode as the
 * empty string), `set` honors an optional positive `ttlSeconds`, and `info`
 * needs no identifier and returns the server info text (optionally filtered by
 * `section`). Execution creates a throwaway `RedisAdapter` (uniquely aliased,
 * always shut down and unregistered in `finally`) with connection settings
 * from config plus an optional `redis`-type credential supplying the password;
 * `value` falls back to the `value` input when unset. The raw client is
 * accessed through a local structural interface, keeping this node independent
 * of the concrete Redis client dependency.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { Adapter } from "@decaf-ts/core";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { RedisAdapter } from "@decaf-ts/integrations/redis";
import {
  asNonEmptyString,
  asNumber,
  resolveCredentialSecret,
} from "../support";

/** Redis operations the node can run. */
export type RedisOperation =
  | "get"
  | "set"
  | "delete"
  | "incr"
  | "keys"
  | "llen"
  | "lpop"
  | "rpop"
  | "lpush"
  | "rpush"
  | "publish"
  | "info";

/** Inputs accepted by the Redis node (the optional `value` input supplies the written value). */
export type RedisNodeInput = Record<string, unknown>;

/** Outputs produced by the Redis node: the operation result plus a count where meaningful. */
export interface RedisNodeOutput {
  result: unknown;
  value?: unknown;
  count?: number;
}

/** Structural shape of the underlying Redis client used by the operation switch. */
interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { EX?: number }
  ): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  lLen(key: string): Promise<number>;
  lPop(key: string, count?: number): Promise<unknown>;
  rPop(key: string, count?: number): Promise<unknown>;
  lPush(key: string, ...values: string[]): Promise<number>;
  rPush(key: string, ...values: string[]): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
  info(section?: string): Promise<string>;
}

/** All supported Redis operations, used to validate the configured operation. */
const OPERATIONS: RedisOperation[] = [
  "get",
  "set",
  "delete",
  "incr",
  "keys",
  "llen",
  "lpop",
  "rpop",
  "lpush",
  "rpush",
  "publish",
  "info",
];

/** Decodes a stored Redis string into a value: JSON when it parses, the raw string otherwise (null passes through). */
function decodeRedisValue(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Encodes a value for storage: strings pass through, null/undefined become the empty string, everything else is JSON-encoded. */
function encodeRedisValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

/**
 * Redis storage node: runs one operation against a Redis server through a throwaway `RedisAdapter`.
 */
@node("core.storage.redis", {
  kind: "core.storage.redis",
  category: "Storage",
  color: "#dc382d",
  icon: "ti-brand-redis",
  width: 96,
  height: 96,
  labels: ["storage", "redis", "cache", "keyvalue"],
  metadata: {
    title: "graph.node.storage.redis.name",
    description: "graph.node.storage.redis.description",
  },
})
@model()
export class RedisNode extends GraphNode<RedisNodeInput, RedisNodeOutput> {
  /**
   * Resolves the operation, connection settings, and identifiers, then runs the operation and emits its result.
   *
   * Connection defaults are `localhost:6379`; an optional `redis` credential supplies the password. The `value`
   * written by `set`/`lpush`/`rpush`/`publish` falls back to the `value` input. Count-producing operations
   * (`delete`, `incr`, `keys`, `lpush`, `rpush`, `publish`) also emit `count`.
   *
   * @param request - The execution request carrying resolved credentials and the optional `value` input.
   * @returns The operation result under `result` (plus `count` where meaningful).
   * @throws {GraphExecutionError} with code `GRAPH_REDIS_KEY_REQUIRED` when the operation needs a key, pattern, or
   *   channel and none is configured, `GRAPH_CREDENTIAL_*` codes from credential resolution, and
   *   `GRAPH_REDIS_OPERATION_FAILED` when the operation fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<RedisNodeInput>
  ): Promise<GraphExecutionValues> {
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "get";
    const password = resolveCredentialSecret(
      request.credentials,
      "redis",
      false,
      "Redis"
    );
    const host = asNonEmptyString(this.host) ?? "localhost";
    const port = asNumber(this.port) ?? 6379;
    const key = asNonEmptyString(this.key);
    const prefix = asNonEmptyString(this.prefix);
    const scopedKey = (value: string): string =>
      prefix ? `${prefix}:${value}` : value;
    const pattern = asNonEmptyString(this.pattern);
    const channel = asNonEmptyString(this.channel);
    const value = this.value ?? request.inputs["value"];
    const hasIdentifier =
      operation === "info" ||
      Boolean(key) ||
      (operation === "keys" && Boolean(pattern)) ||
      (operation === "publish" && Boolean(channel));
    if (!hasIdentifier) {
      throw new GraphExecutionError(
        `Redis node operation '${operation}' requires a key`,
        "GRAPH_REDIS_KEY_REQUIRED",
        { operation }
      );
    }
    const alias = `as-graph-redis-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const adapter = new RedisAdapter(
      {
        host,
        port,
        username: asNonEmptyString(this.username),
        password,
        database: asNumber(this.database),
      },
      alias
    );
    try {
      await adapter.initialize();
      const client = adapter.client as unknown as RedisClientLike;
      switch (operation) {
        case "get":
          return { result: decodeRedisValue(await client.get(scopedKey(key as string))) };
        case "set": {
          const ttl = asNumber(this.ttlSeconds);
          const result = await client.set(
            scopedKey(key as string),
            encodeRedisValue(value),
            ttl && ttl > 0 ? { EX: Math.floor(ttl) } : undefined
          );
          return { result };
        }
        case "delete": {
          const count = await client.del(scopedKey(key as string));
          return { result: count, count };
        }
        case "incr": {
          const count = await client.incr(scopedKey(key as string));
          return { result: count, count };
        }
        case "keys": {
          const result = await client.keys(scopedKey(pattern ?? key ?? "*"));
          return { result, count: result.length };
        }
        case "llen": {
          const count = await client.lLen(scopedKey(key as string));
          return { result: count, count };
        }
        case "lpop": {
          const result = await client.lPop(scopedKey(key as string));
          return { result: decodeRedisValue(result as string | null) };
        }
        case "rpop": {
          const result = await client.rPop(scopedKey(key as string));
          return { result: decodeRedisValue(result as string | null) };
        }
        case "lpush": {
          const count = await client.lPush(
            scopedKey(key as string),
            encodeRedisValue(value)
          );
          return { result: count, count };
        }
        case "rpush": {
          const count = await client.rPush(
            scopedKey(key as string),
            encodeRedisValue(value)
          );
          return { result: count, count };
        }
        case "publish": {
          const count = await client.publish(
            channel ?? (key as string),
            encodeRedisValue(value)
          );
          return { result: count, count };
        }
        default:
          return {
            result: await client.info(
              asNonEmptyString(this.section)
            ),
          };
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Redis node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_REDIS_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await adapter.shutdown().catch(() => undefined);
      Adapter.unregister(alias);
    }
  }

  /** Operation to run (defaults to `get`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: RedisOperation = "get";

  /** Redis server host (default `localhost`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.host.label",
    type: "string",
  })
  @input({ handle: "host", userControlled: true })
  host?: string;

  /** Redis server port (default 6379). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.port.label",
    type: "number",
  })
  @input({ handle: "port", userControlled: true })
  port?: number;

  /** Optional ACL username. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.username.label",
    type: "string",
  })
  @input({ handle: "username", userControlled: true })
  username?: string;

  /** Optional logical database index. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.database.label",
    type: "number",
  })
  @input({ handle: "database", userControlled: true })
  database?: number;

  /** Optional namespace prefix applied as `prefix:key` to keys, patterns, and channels. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.prefix.label",
    type: "string",
  })
  @input({ handle: "prefix", userControlled: true })
  prefix?: string;

  /** Key the operation targets (also the channel fallback for `publish`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.key.label",
    type: "string",
  })
  @input({ handle: "key", userControlled: true })
  key?: string;

  /** Value written by `set`/`lpush`/`rpush`/`publish` (falls back to the `value` input). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.value.label",
    type: "textarea",
  })
  @input({ handle: "value", userControlled: true })
  value?: unknown;

  /** Optional expiry for `set`, floored and applied only when positive. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.ttlSeconds.label",
    type: "number",
  })
  @input({ handle: "ttlSeconds", userControlled: true })
  ttlSeconds?: number;

  /** Glob pattern for the `keys` operation. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.pattern.label",
    type: "string",
  })
  @input({ handle: "pattern", userControlled: true })
  pattern?: string;

  /** Channel for the `publish` operation. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.channel.label",
    type: "string",
  })
  @input({ handle: "channel", userControlled: true })
  channel?: string;

  /** Optional info section filter for the `info` operation. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.redis.fields.section.label",
    type: "string",
  })
  @input({ handle: "section", userControlled: true })
  section?: string;

  /** Operation result (decoded value, count, key list, or info text depending on the operation). */
  @required()
  @output({ handle: "result" })
  result!: unknown;

  /** Output handle `value` (currently unused by the operation switch). */
  @output({ handle: "value" })
  valueOutput?: unknown;

  /** Count emitted by count-producing operations. */
  @output({ handle: "count", type: "number" })
  count?: number;
}
