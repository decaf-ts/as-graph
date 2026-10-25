/**
 * @module as-graph/nodes/triggers/postgres
 * @summary PostgreSQL trigger node declaration (Stage 5b).
 * @description Postgres trigger — listens on a Postgres `LISTEN`/`NOTIFY`
 * channel and emits the first notification, driving the run. The connection
 * uses the `pg` driver directly (plan amended R2; there is no decaf
 * LISTEN/NOTIFY service) with the same TLS policy as the Stage 3a
 * `core.storage.postgres` node: certificate verification is on unless the
 * explicit `acceptSelfSigned` toggle is set. An optional `postgres`
 * credential supplies the connection password through the ctx-bound node
 * credential resolver.
 *
 * Kind-level parity (R6): this port reproduces the trigger's purpose (react to
 * Postgres messages) and its primary configuration (connection + channel).
 * n8n's table-row-change mode, which installs `AFTER INSERT/UPDATE/DELETE`
 * triggers and helper functions in the target database, is deliberately not
 * ported — it mutates the monitored schema. Emit the same payload from the
 * application (or an existing database trigger) with
 * `pg_notify('<channel>', '<json>')` instead. The wait honours `timeoutMs`
 * and the run abort signal, and the connection is always closed.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { Client } from "pg";
import type { Notification } from "pg";
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

/** Inputs accepted by the Postgres trigger (none — it is an entrypoint). */
export type PostgresTriggerInput = Record<string, unknown>;

/** Outputs produced by the Postgres trigger. */
export interface PostgresTriggerOutput {
  payload: unknown;
  message?: string;
  channel?: string;
}

/** Postgres identifiers accepted as a notification channel (safe to quote). */
const CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Postgres trigger node: listens for the first notification on a channel.
 */
@node("core.trigger.postgres", {
  kind: "core.trigger.postgres",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-database",
  width: 96,
  height: 96,
  labels: ["trigger", "postgres", "sql", "listen", "notify"],
  metadata: {
    title: "graph.node.trigger.postgres.name",
    description: "graph.node.trigger.postgres.description",
    trigger: {
      type: "postgres",
      channel: "",
      jsonParseBody: false,
    },
  },
})
@model()
export class PostgresTriggerNode extends GraphNode<
  PostgresTriggerInput,
  PostgresTriggerOutput
> {
  /**
   * Listens on the configured channel and emits the first notification.
   *
   * @param request - The execution request carrying resolved credentials.
   * @param context - The node execution context (run abort signal).
   * @returns The notification payload, raw text, and channel.
   * @throws {GraphExecutionError} `GRAPH_POSTGRES_TRIGGER_CHANNEL_REQUIRED` /
   *   `GRAPH_POSTGRES_TRIGGER_CHANNEL_INVALID` for a missing or unsafe channel,
   *   `GRAPH_POSTGRES_TRIGGER_CONNECTION_REQUIRED` for incomplete connection
   *   settings, `GRAPH_TRIGGER_TIMEOUT` when no notification arrives in time,
   *   `GRAPH_TRIGGER_ABORTED` when the run is cancelled, and
   *   `GRAPH_POSTGRES_TRIGGER_FAILED` for connection or listen failures.
   */
  override async execute(
    request: GraphNodeExecutionRequest<PostgresTriggerInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const channel = asNonEmptyString(this.channel);
    if (!channel) {
      throw new GraphExecutionError(
        "Postgres trigger requires a channel",
        "GRAPH_POSTGRES_TRIGGER_CHANNEL_REQUIRED"
      );
    }
    if (!CHANNEL_PATTERN.test(channel)) {
      throw new GraphExecutionError(
        `Postgres trigger channel '${channel}' is not a valid identifier`,
        "GRAPH_POSTGRES_TRIGGER_CHANNEL_INVALID",
        { channel }
      );
    }
    const database = asNonEmptyString(this.database);
    const username = asNonEmptyString(this.username);
    if (!database || !username) {
      throw new GraphExecutionError(
        "Postgres trigger requires a database and username",
        "GRAPH_POSTGRES_TRIGGER_CONNECTION_REQUIRED"
      );
    }
    const password = credentialSecret(
      await resolveNodeCredential(
        context,
        request.credentials,
        "postgres",
        false,
        "Postgres trigger"
      ),
      ["password", "secret", "token"],
      "Postgres trigger"
    );
    const ssl = asBoolean(this.ssl, false);
    const acceptSelfSigned = asBoolean(this.acceptSelfSigned, false);
    const timeoutMs = triggerTimeoutMs(this.timeoutMs);
    const client = new Client({
      host: asNonEmptyString(this.host) ?? "localhost",
      port: asNumber(this.port) ?? 5432,
      database,
      user: username,
      password,
      ssl: ssl ? { rejectUnauthorized: !acceptSelfSigned } : false,
    });

    try {
      await client.connect();
      const event = await waitForTriggerEvent<{
        channel: string;
        message: string;
      }>(
        context,
        timeoutMs,
        async (emit) => {
          client.on("notification", (message: Notification) => {
            if (message.channel !== channel) return;
            emit({
              channel: message.channel,
              message: message.payload ?? "",
            });
          });
          await client.query(`LISTEN "${channel}"`);
          await context.log("Postgres trigger listening", { channel });
          return async () => {
            await client.query(`UNLISTEN "${channel}"`).catch(() => undefined);
          };
        },
        "GRAPH_TRIGGER_TIMEOUT",
        `Postgres trigger received no notification within ${timeoutMs}ms`
      );
      return {
        payload: triggerPayload(event.message, this.jsonParseBody === true),
        message: event.message,
        channel: event.channel,
      };
    } catch (error) {
      throw triggerFailure(
        "Postgres",
        "GRAPH_POSTGRES_TRIGGER_FAILED",
        error
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Database host (default `localhost`). */
  @input({ handle: "host", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.postgres.fields.host.label",
    type: "string",
  })
  host?: string;

  /** Database port (default 5432). */
  @input({ handle: "port", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.postgres.fields.port.label",
    type: "number",
  })
  port?: number;

  /** Database name. */
  @required()
  @input({ handle: "database", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.postgres.fields.database.label",
    type: "string",
  })
  database?: string;

  /** Connection username. */
  @required()
  @input({ handle: "username", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.postgres.fields.username.label",
    type: "string",
  })
  username?: string;

  /** `LISTEN` channel to subscribe to. */
  @required()
  @input({ handle: "channel" })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.postgres.fields.channel.label",
    placeholder: "graph.node.trigger.postgres.fields.channel.placeholder",
    type: "string",
  })
  channel?: string;

  /** Enable TLS. */
  @input({ handle: "ssl", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.postgres.fields.ssl.label",
    type: "boolean",
  })
  ssl: boolean = false;

  /** Accept a self-signed TLS certificate (only meaningful with `ssl`). */
  @input({ handle: "acceptSelfSigned", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.postgres.fields.acceptSelfSigned.label",
    type: "boolean",
  })
  acceptSelfSigned: boolean = false;

  /** Parse the notification payload as JSON when possible (raw string otherwise). */
  @input({ handle: "jsonParseBody", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.postgres.fields.jsonParseBody.label",
    type: "boolean",
  })
  jsonParseBody: boolean = false;

  /** Maximum wait for the first notification in milliseconds (default 30000). */
  @input({ handle: "timeoutMs", userControlled: true })
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.postgres.fields.timeoutMs.label",
    type: "number",
  })
  timeoutMs?: number;

  /** The notification payload, JSON-projected when `jsonParseBody` is enabled. */
  @required()
  @output({ handle: "payload" })
  payload!: unknown;

  /** The raw notification payload text. */
  @output({ handle: "message" })
  message?: string;

  /** The channel that delivered the notification. */
  @output({ handle: "channel" })
  channelOutput?: string;
}
