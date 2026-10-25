/**
 * @module as-graph/nodes/triggers/redis
 * @summary Redis trigger node declaration (Stage 5b).
 * @description Redis trigger — subscribes to one or more Redis pub/sub
 * channels (glob patterns supported) and emits the first received message,
 * driving the run. The subscription uses the Stage 3a `integrations/redis`
 * service (`RedisAdapter`) so connection settings, TLS, database selection,
 * and credential handling match the `core.storage.redis` node. The channel
 * prefix, when set, scopes every pattern (`prefix:pattern`), matching the
 * producer node's `publish` operation. A `jsonParseBody` toggle projects the
 * raw message as JSON when it parses. The wait is bounded by `timeoutMs` and
 * follows the run's abort signal so cancellation never leaks a subscriber.
 *
 * Producing side: `core.storage.redis` with `operation: "publish"` on the
 * same channel/prefix emits the message the trigger consumes.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { Adapter } from "@decaf-ts/core";
import { RedisAdapter } from "@decaf-ts/integrations/redis";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import {
  asNonEmptyString,
  asNumber,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialSecret } from "../../credentials";
import {
  triggerFailure,
  triggerPayload,
  triggerTimeoutMs,
  waitForTriggerEvent,
} from "../support";

/** Inputs accepted by the Redis trigger (none — it is an entrypoint). */
export type RedisTriggerInput = Record<string, unknown>;

/** Outputs produced by the Redis trigger. */
export interface RedisTriggerOutput {
  payload: unknown;
  message?: string;
  channel?: string;
}

interface RedisSubscriberClient {
  pSubscribe(
    pattern: string,
    listener: (message: string, channel: string) => void
  ): Promise<unknown>;
  pUnsubscribe(): Promise<unknown>;
}

/**
 * Redis trigger node: subscribes to pub/sub channels and emits the first
 * message as the run payload.
 */
@node("core.trigger.redis", {
  kind: "core.trigger.redis",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-brand-redis",
  width: 96,
  height: 96,
  labels: ["trigger", "redis", "pubsub", "channel"],
  metadata: {
    title: "graph.node.trigger.redis.name",
    description: "graph.node.trigger.redis.description",
    trigger: {
      type: "redis",
      channels: "",
      jsonParseBody: false,
    },
  },
})
@model()
export class RedisTriggerNode extends GraphNode<
  RedisTriggerInput,
  RedisTriggerOutput
> {
  /**
   * Subscribes to the configured channels and emits the first received message.
   *
   * @param request - The execution request carrying resolved credentials.
   * @param context - The node execution context (run abort signal).
   * @returns The message payload, the raw message, and the source channel.
   * @throws {GraphExecutionError} `GRAPH_REDIS_TRIGGER_CHANNELS_REQUIRED` when
   *   no channel is configured, `GRAPH_TRIGGER_TIMEOUT` when no message arrives
   *   in time, `GRAPH_TRIGGER_ABORTED` when the run is cancelled, and
   *   `GRAPH_REDIS_TRIGGER_FAILED` for connection or subscription failures.
   */
  override async execute(
    request: GraphNodeExecutionRequest<RedisTriggerInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const channels = asNonEmptyString(this.channels);
    if (!channels) {
      throw new GraphExecutionError(
        "Redis trigger requires at least one channel",
        "GRAPH_REDIS_TRIGGER_CHANNELS_REQUIRED"
      );
    }
    const prefix = asNonEmptyString(this.prefix);
    const patterns = channels
      .split(",")
      .map((channel) => channel.trim())
      .filter((channel) => channel.length > 0)
      .map((channel) => (prefix ? `${prefix}:${channel}` : channel));
    if (!patterns.length) {
      throw new GraphExecutionError(
        "Redis trigger requires at least one channel",
        "GRAPH_REDIS_TRIGGER_CHANNELS_REQUIRED"
      );
    }

    const password = credentialSecret(
      await resolveNodeCredential(
        context,
        request.credentials,
        "redis",
        false,
        "Redis trigger"
      ),
      ["password", "secret", "token"],
      "Redis trigger"
    );
    const timeoutMs = triggerTimeoutMs(this.timeoutMs);
    const alias = `as-graph-redis-trigger-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const adapter = new RedisAdapter(
      {
        host: asNonEmptyString(this.host) ?? "localhost",
        port: asNumber(this.port) ?? 6379,
        username: asNonEmptyString(this.username),
        password,
        database: asNumber(this.database),
        tls: this.tls ? true : undefined,
      },
      alias
    );

    try {
      await adapter.initialize();
      const client = adapter.client as unknown as RedisSubscriberClient;
      const event = await waitForTriggerEvent<{
        channel: string;
        message: string;
      }>(
        context,
        timeoutMs,
        async (emit) => {
          for (const pattern of patterns) {
            await client.pSubscribe(pattern, (message, channel) =>
              emit({ channel, message })
            );
          }
          await context.log("Redis trigger subscribed", {
            channels: patterns,
          });
          return async () => {
            await client.pUnsubscribe().catch(() => undefined);
          };
        },
        "GRAPH_TRIGGER_TIMEOUT",
        `Redis trigger received no message within ${timeoutMs}ms`
      );
      return {
        payload: triggerPayload(event.message, this.jsonParseBody === true),
        message: event.message,
        channel: event.channel,
      };
    } catch (error) {
      throw triggerFailure(
        "Redis",
        "GRAPH_REDIS_TRIGGER_FAILED",
        error
      );
    } finally {
      await adapter.shutdown().catch(() => undefined);
      Adapter.unregister(alias);
    }
  }

  /** Comma-separated channels or glob patterns to subscribe to. */
  @required()
  @input({ handle: "channels" })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.redis.fields.channels.label",
    placeholder: "graph.node.trigger.redis.fields.channels.placeholder",
    type: "string",
  })
  channels?: string;

  /** Redis server host (default `localhost`). */
  @input({ handle: "host", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.redis.fields.host.label",
    type: "string",
  })
  host?: string;

  /** Redis server port (default 6379). */
  @input({ handle: "port", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.redis.fields.port.label",
    type: "number",
  })
  port?: number;

  /** Optional ACL username. */
  @input({ handle: "username", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.redis.fields.username.label",
    type: "string",
  })
  username?: string;

  /** Optional logical database index. */
  @input({ handle: "database", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.redis.fields.database.label",
    type: "number",
  })
  database?: number;

  /** Enable TLS for the Redis connection. */
  @input({ handle: "tls", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.redis.fields.tls.label",
    type: "boolean",
  })
  tls: boolean = false;

  /** Optional namespace prefix applied as `prefix:channel`. */
  @input({ handle: "prefix", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.redis.fields.prefix.label",
    type: "string",
  })
  prefix?: string;

  /** Parse the received message as JSON when possible (raw string otherwise). */
  @input({ handle: "jsonParseBody", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.redis.fields.jsonParseBody.label",
    type: "boolean",
  })
  jsonParseBody: boolean = false;

  /** Maximum wait for the first message in milliseconds (default 30000). */
  @input({ handle: "timeoutMs", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.redis.fields.timeoutMs.label",
    type: "number",
  })
  timeoutMs?: number;

  /** The received message, JSON-projected when `jsonParseBody` is enabled. */
  @required()
  @output({ handle: "payload" })
  payload!: unknown;

  /** The raw received message text. */
  @output({ handle: "message" })
  message?: string;

  /** The channel that delivered the message. */
  @output({ handle: "channel" })
  channel?: string;
}
