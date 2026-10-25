/**
 * @module as-graph/nodes/storage/rabbitmq
 * @summary RabbitMQ producer node declaration (Stage 5b).
 * @description RabbitMQ — publish a message to a queue or a topic exchange.
 * This is the producer pairing node for `core.trigger.rabbitmq`: a message
 * sent with this node fires the trigger and drives its run. The connection
 * uses `amqplib` directly (the plan's amended R2 direct-library allowance —
 * no decaf AMQP service exists) and accepts an optional `rabbitmq` credential
 * supplying the password through the ctx-bound node credential resolver.
 *
 * Kind-level parity (R6): the node reproduces the RabbitMQ node's primary
 * purpose (send a message) and primary configuration (queue, or exchange +
 * routing key, plus connection/auth). n8n's secondary `deleteMessage`
 * operation and its retry/acknowledgement/credential-store options are out of
 * scope. The exchange type defaults to `topic`.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connect } from "amqplib";
import type { ChannelModel, ConfirmChannel } from "amqplib";
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
} from "../support";
import { credentialSecret } from "../../credentials";

/** Target the RabbitMQ node publishes to. */
export type RabbitMqPublishMode = "queue" | "exchange";

/** Inputs accepted by the RabbitMQ node (the optional `value` input is the message). */
export type RabbitMqNodeInput = Record<string, unknown>;

/** Outputs produced by the RabbitMQ node. */
export interface RabbitMqNodeOutput {
  result: boolean;
  target?: string;
}

const MODES: RabbitMqPublishMode[] = ["queue", "exchange"];

/** Serializes a message value: strings pass through, everything else is JSON-encoded. */
function encodeMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

/**
 * RabbitMQ producer node: publishes one message to a queue or topic exchange.
 */
@node("core.storage.rabbitmq", {
  kind: "core.storage.rabbitmq",
  category: "Storage",
  color: "#ff6600",
  icon: "ti-inbox",
  width: 96,
  height: 96,
  labels: ["storage", "rabbitmq", "amqp", "queue", "publish"],
  metadata: {
    title: "graph.node.storage.rabbitmq.name",
    description: "graph.node.storage.rabbitmq.description",
  },
})
@model()
export class RabbitMqNode extends GraphNode<
  RabbitMqNodeInput,
  RabbitMqNodeOutput
> {
  /**
   * Publishes the configured message and reports whether the broker accepted it.
   *
   * @param request - The execution request carrying resolved credentials and the optional `value` input.
   * @param context - The node execution context forwarded to the ctx-bound credential resolver.
   * @returns `result: true` and the published `target`.
   * @throws {GraphExecutionError} `GRAPH_RABBITMQ_QUEUE_REQUIRED` /
   *   `GRAPH_RABBITMQ_EXCHANGE_REQUIRED` when the target is missing,
   *   `GRAPH_CREDENTIAL_*` codes from credential resolution, and
   *   `GRAPH_RABBITMQ_PUBLISH_FAILED` when the broker call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<RabbitMqNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const mode = MODES.includes(this.mode) ? this.mode : "queue";
    const queue = asNonEmptyString(this.queue);
    const exchange = asNonEmptyString(this.exchange);
    const routingKey = asNonEmptyString(this.routingKey) ?? "";
    if (mode === "queue" && !queue) {
      throw new GraphExecutionError(
        "RabbitMQ node requires a queue when publishing to a queue",
        "GRAPH_RABBITMQ_QUEUE_REQUIRED"
      );
    }
    if (mode === "exchange" && !exchange) {
      throw new GraphExecutionError(
        "RabbitMQ node requires an exchange when publishing to an exchange",
        "GRAPH_RABBITMQ_EXCHANGE_REQUIRED"
      );
    }

    const password = credentialSecret(
      await resolveNodeCredential(
        context,
        request.credentials,
        "rabbitmq",
        false,
        "RabbitMQ"
      ),
      ["password", "secret", "token"],
      "RabbitMQ"
    );
    const ssl = asBoolean(this.ssl, false);
    const message = encodeMessage(
      this.value ??
        request.inputs["value"] ??
        request.inputs["payload"] ??
        request.inputs["message"]
    );

    let connection: ChannelModel | undefined;
    let channel: ConfirmChannel | undefined;
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
      channel = await connection.createConfirmChannel();
      let target: string;
      if (mode === "exchange") {
        const exchangeType = asNonEmptyString(this.exchangeType) ?? "topic";
        await channel.assertExchange(exchange as string, exchangeType, {
          durable: true,
        });
        channel.publish(
          exchange as string,
          routingKey,
          Buffer.from(message, "utf8"),
          {
            contentType: "application/json",
            contentEncoding: "utf8",
          }
        );
        target = exchange as string;
      } else {
        await channel.assertQueue(queue as string, { durable: true });
        channel.sendToQueue(queue as string, Buffer.from(message, "utf8"), {
          contentType: "application/json",
          contentEncoding: "utf8",
        });
        target = queue as string;
      }
      await channel.waitForConfirms();
      return { result: true, target };
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `RabbitMQ node publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_RABBITMQ_PUBLISH_FAILED",
        { mode }
      );
    } finally {
      await channel?.close().catch(() => undefined);
      await connection?.close().catch(() => undefined);
    }
  }

  /** Publish target: a queue (default) or a topic exchange. */
  @input({ handle: "mode", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.rabbitmq.fields.mode.label",
    type: "select",
  })
  mode: RabbitMqPublishMode = "queue";

  /** Queue that receives the message in queue mode. */
  @input({ handle: "queue", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.rabbitmq.fields.queue.label",
    type: "string",
  })
  queue?: string;

  /** Exchange that receives the message in exchange mode. */
  @input({ handle: "exchange", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.rabbitmq.fields.exchange.label",
    type: "string",
  })
  exchange?: string;

  /** Exchange type asserted in exchange mode (default `topic`). */
  @input({ handle: "exchangeType", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.rabbitmq.fields.exchangeType.label",
    type: "string",
  })
  exchangeType?: string;

  /** Routing key used in exchange mode. */
  @input({ handle: "routingKey", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.rabbitmq.fields.routingKey.label",
    type: "string",
  })
  routingKey?: string;

  /** RabbitMQ server host (default `localhost`). */
  @input({ handle: "host", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.rabbitmq.fields.host.label",
    type: "string",
  })
  host?: string;

  /** RabbitMQ server port (default 5672; 5671 with TLS). */
  @input({ handle: "port", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.rabbitmq.fields.port.label",
    type: "number",
  })
  port?: number;

  /** Connection username (default `guest`). */
  @input({ handle: "username", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.rabbitmq.fields.username.label",
    type: "string",
  })
  username?: string;

  /** Virtual host (default `/`). */
  @input({ handle: "vhost", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.rabbitmq.fields.vhost.label",
    type: "string",
  })
  vhost?: string;

  /** Enable TLS (`amqps`). */
  @input({ handle: "ssl", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.rabbitmq.fields.ssl.label",
    type: "boolean",
  })
  ssl: boolean = false;

  /** Message body (falls back to the `value`, `payload`, then `message` input). */
  @input({ handle: "value", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.rabbitmq.fields.value.label",
    type: "textarea",
  })
  value?: unknown;

  /** Whether the broker accepted the message. */
  @required()
  @output({ handle: "result", type: "boolean" })
  result!: boolean;

  /** Queue or exchange the message was published to. */
  @output({ handle: "target" })
  target?: string;
}
