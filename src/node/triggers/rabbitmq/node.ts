/**
 * @module as-graph/nodes/triggers/rabbitmq
 * @summary RabbitMQ trigger node declaration (Stage 5b).
 * @description RabbitMQ trigger — consumes one message from a queue and emits
 * it, driving the run. The node uses `amqplib` directly (plan amended R2:
 * there is no decaf AMQP service, so the library wrap is the simpler path)
 * and an optional `rabbitmq` credential supplying the password through the
 * ctx-bound node credential resolver. The queue is asserted durable; an
 * optional exchange/routing-key pair binds it to a topic exchange so a
 * producer publishing through the exchange reaches the trigger. One message
 * per run is consumed and acknowledged immediately, matching the run-based
 * trigger contract. The wait honours `timeoutMs` and the run abort signal.
 *
 * Producing side: `core.storage.rabbitmq` publishes to the same queue (or to
 * the bound exchange) and thus fires this trigger.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connect } from "amqplib";
import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import {
  asBoolean,
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

/** Inputs accepted by the RabbitMQ trigger (none — it is an entrypoint). */
export type RabbitMqTriggerInput = Record<string, unknown>;

/** Outputs produced by the RabbitMQ trigger. */
export interface RabbitMqTriggerOutput {
  payload: unknown;
  message?: string;
  queue?: string;
  properties?: Record<string, unknown>;
}

/** Projects AMQP message properties onto a JSON-safe record (undefined fields omitted). */
function jsonSafeProperties(
  properties: ConsumeMessage["properties"]
): Record<string, unknown> {
  const timestamp = properties?.timestamp;
  const record: Record<string, unknown> = {
    contentType: properties?.contentType,
    contentEncoding: properties?.contentEncoding,
    correlationId: properties?.correlationId,
    replyTo: properties?.replyTo,
    messageId: properties?.messageId,
    type: properties?.type,
    appId: properties?.appId,
    timestamp:
      timestamp instanceof Date
        ? timestamp.toISOString()
        : timestamp === undefined
          ? undefined
          : String(timestamp),
  };
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) delete record[key];
  }
  return record;
}

/**
 * RabbitMQ trigger node: consumes the first message from a queue and emits it.
 */
@node("core.trigger.rabbitmq", {
  kind: "core.trigger.rabbitmq",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-inbox",
  width: 96,
  height: 96,
  labels: ["trigger", "rabbitmq", "amqp", "queue"],
  metadata: {
    title: "graph.node.trigger.rabbitmq.name",
    description: "graph.node.trigger.rabbitmq.description",
    trigger: {
      type: "rabbitmq",
      queue: "",
      jsonParseBody: false,
    },
  },
})
@model()
export class RabbitMqTriggerNode extends GraphNode<
  RabbitMqTriggerInput,
  RabbitMqTriggerOutput
> {
  /**
   * Consumes the first message on the configured queue and emits its content.
   *
   * @param request - The execution request carrying resolved credentials.
   * @param context - The node execution context (run abort signal).
   * @returns The message payload, raw text, queue name, and projected properties.
   * @throws {GraphExecutionError} `GRAPH_RABBITMQ_TRIGGER_QUEUE_REQUIRED` when no
   *   queue is configured, `GRAPH_TRIGGER_TIMEOUT` when no message arrives in
   *   time, `GRAPH_TRIGGER_ABORTED` when the run is cancelled, and
   *   `GRAPH_RABBITMQ_TRIGGER_FAILED` for connection or consume failures.
   */
  override async execute(
    request: GraphNodeExecutionRequest<RabbitMqTriggerInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const queue = asNonEmptyString(this.queue);
    if (!queue) {
      throw new GraphExecutionError(
        "RabbitMQ trigger requires a queue",
        "GRAPH_RABBITMQ_TRIGGER_QUEUE_REQUIRED"
      );
    }
    const exchange = asNonEmptyString(this.exchange);
    const routingKey = asNonEmptyString(this.routingKey) ?? "";
    const password = credentialSecret(
      await resolveNodeCredential(
        context,
        request.credentials,
        "rabbitmq",
        false,
        "RabbitMQ trigger"
      ),
      ["password", "secret", "token"],
      "RabbitMQ trigger"
    );
    const ssl = asBoolean(this.ssl, false);
    const timeoutMs = triggerTimeoutMs(this.timeoutMs);

    let connection: ChannelModel | undefined;
    let channel: Channel | undefined;
    try {
      connection = await connect({
        protocol: ssl ? "amqps" : "amqp",
        hostname: asNonEmptyString(this.host) ?? "localhost",
        port: asNumber(this.port) ?? (ssl ? 5671 : 5672),
        username: asNonEmptyString(this.username) ?? "guest",
        password,
        vhost: asNonEmptyString(this.vhost) ?? "/",
        heartbeat: 10,
      });
      channel = await connection.createChannel();
      await channel.assertQueue(queue, { durable: true });
      if (exchange) {
        await channel.assertExchange(
          exchange,
          asNonEmptyString(this.exchangeType) ?? "topic",
          { durable: true }
        );
        await channel.bindQueue(queue, exchange, routingKey);
      }
      await channel.prefetch(1);

      const event = await waitForTriggerEvent<{
        message: string;
        properties: Record<string, unknown>;
      }>(
        context,
        timeoutMs,
        async (emit) => {
          const consumer = await channel!.consume(
            queue,
            (message: ConsumeMessage | null) => {
              if (!message) return;
              const raw = message.content.toString("utf8");
              try {
                channel!.ack(message);
              } catch {
                // the delivery is redelivered when the ack cannot be sent
              }
              emit({
                message: raw,
                properties: jsonSafeProperties(message.properties),
              });
            },
            { noAck: false }
          );
          await context.log("RabbitMQ trigger subscribed", { queue });
          return async () => {
            await channel!.cancel(consumer.consumerTag).catch(() => undefined);
          };
        },
        "GRAPH_TRIGGER_TIMEOUT",
        `RabbitMQ trigger received no message within ${timeoutMs}ms`
      );
      return {
        payload: triggerPayload(event.message, this.jsonParseBody === true),
        message: event.message,
        queue,
        properties: event.properties,
      };
    } catch (error) {
      throw triggerFailure(
        "RabbitMQ",
        "GRAPH_RABBITMQ_TRIGGER_FAILED",
        error
      );
    } finally {
      await channel?.close().catch(() => undefined);
      await connection?.close().catch(() => undefined);
    }
  }

  /** Queue to consume from. */
  @required()
  @input({ handle: "queue" })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.rabbitmq.fields.queue.label",
    placeholder: "queue-name",
    type: "string",
  })
  queue?: string;

  /** Optional exchange to bind the queue to before consuming. */
  @input({ handle: "exchange", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.rabbitmq.fields.exchange.label",
    type: "string",
  })
  exchange?: string;

  /** Exchange type asserted when an exchange binding is configured (default `topic`). */
  @input({ handle: "exchangeType", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.rabbitmq.fields.exchangeType.label",
    type: "string",
  })
  exchangeType?: string;

  /** Routing key used for the optional exchange binding. */
  @input({ handle: "routingKey", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.rabbitmq.fields.routingKey.label",
    type: "string",
  })
  routingKey?: string;

  /** RabbitMQ server host (default `localhost`). */
  @input({ handle: "host", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.rabbitmq.fields.host.label",
    type: "string",
  })
  host?: string;

  /** RabbitMQ server port (default 5672; 5671 with TLS). */
  @input({ handle: "port", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.rabbitmq.fields.port.label",
    type: "number",
  })
  port?: number;

  /** Connection username (default `guest`). */
  @input({ handle: "username", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.rabbitmq.fields.username.label",
    type: "string",
  })
  username?: string;

  /** Virtual host (default `/`). */
  @input({ handle: "vhost", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.rabbitmq.fields.vhost.label",
    type: "string",
  })
  vhost?: string;

  /** Enable TLS (`amqps`). */
  @input({ handle: "ssl", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.rabbitmq.fields.ssl.label",
    type: "boolean",
  })
  ssl: boolean = false;

  /** Parse the received message as JSON when possible (raw string otherwise). */
  @input({ handle: "jsonParseBody", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.rabbitmq.fields.jsonParseBody.label",
    type: "boolean",
  })
  jsonParseBody: boolean = false;

  /** Maximum wait for the first message in milliseconds (default 30000). */
  @input({ handle: "timeoutMs", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.rabbitmq.fields.timeoutMs.label",
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

  /** Queue the message was consumed from. */
  @output({ handle: "queue" })
  queueOutput?: string;

  /** JSON-safe projection of the AMQP message properties. */
  @output({ handle: "properties", type: "object" })
  properties?: Record<string, unknown>;
}
