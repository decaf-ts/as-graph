/**
 * @module as-graph/tests/integration/graph/nodes/triggers/Stage5bEventingTriggersLive
 * @summary Live integration coverage for the Stage 5b eventing triggers and
 * the RabbitMQ producer pairing (SAA-1452).
 * @description Every run is started through {@link GraphRunService}
 * (`createRun` → subscribe to the run stream → wait for the trigger's
 * subscription log → publish/emit → `waitForRun`), asserting the run completes
 * with the emitted payload. The producers are the real sibling nodes
 * (`core.storage.redis` publish, `core.storage.rabbitmq` queue/exchange,
 * `core.storage.postgres` `pg_notify`) and a local SSE `http` server. Queue,
 * exchange, channel, and workflow names are process-unique and torn down in
 * `afterAll`.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect as amqpConnect } from "amqplib";
import type { Channel, ChannelModel } from "amqplib";

import type { GraphWorkflowDocument } from "../../../../../src/shared/graph";
import {
  GraphExecutionEventType,
  type GraphRunEventEnvelope,
} from "../../../../../src/shared/graph";
import type { GraphExecutionEngine } from "../../../../../src/engine/execution/GraphExecutionEngine";
import type { GraphNodeCatalogue } from "../../../../../src/engine/catalog/GraphNodeCatalogue";
import { GraphNodeExecutorRegistry } from "../../../../../src/engine/registry/GraphNodeExecutorRegistry";
import { registerBuiltInGraphNodes } from "../../../../../src/engine/catalog/GraphBuiltInRegistrations";
import {
  GraphRunService,
  InMemoryGraphRunEventStore,
  InMemoryGraphRunStore,
  type GraphRun,
} from "../../../../../src";
import { RedisNode } from "../../../../../src/node/storage/redis/node";
import { PostgresNode } from "../../../../../src/node/storage/database/postgres/node";
import { RabbitMqNode } from "../../../../../src/node/storage/rabbitmq/node";
import {
  bootEngine,
  documentEdge,
  documentNode,
  documentPort,
  freshCatalogue,
} from "../../../../unit/graph/engine-fixtures";
import {
  ENDPOINTS,
  TEST_CREDENTIAL_SERVICES,
  clearCredentials,
  credential,
  runNode,
  setCredential,
  uniqueName,
} from "../real-service-support";

jest.setTimeout(120_000);

const TRIGGER_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 45_000;

const RABBIT_CREDENTIAL = "saa1452-rabbitmq";
const PG_CREDENTIAL = "saa1452-postgres";

let engine: GraphExecutionEngine;
let catalogue: GraphNodeCatalogue;

beforeAll(async () => {
  catalogue = freshCatalogue();
  engine = await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    nodeCredentials: TEST_CREDENTIAL_SERVICES,
  });
  await registerBuiltInGraphNodes(catalogue);
  setCredential(
    RABBIT_CREDENTIAL,
    { password: ENDPOINTS.rabbitmq.password },
    { credentialType: "rabbitmq" }
  );
  setCredential(
    PG_CREDENTIAL,
    { password: ENDPOINTS.postgres.password },
    { credentialType: "postgres" }
  );
});

afterAll(() => {
  clearCredentials(RABBIT_CREDENTIAL, PG_CREDENTIAL);
});

/** Creates an isolated run service bound to the shared test engine. */
function newService(): GraphRunService {
  return new GraphRunService(
    engine,
    new InMemoryGraphRunStore(),
    new InMemoryGraphRunEventStore(),
    {
      limits: {
        executionTimeoutMs: RUN_TIMEOUT_MS,
        eventReplayWindowMs: 1_000,
        maxEventsPerRun: 1_000,
      },
    }
  );
}

/** Whether an envelope is a terminal run event. */
function isTerminalEvent(envelope: GraphRunEventEnvelope): boolean {
  return [
    GraphExecutionEventType.WORKFLOW_COMPLETED,
    GraphExecutionEventType.WORKFLOW_FAILED,
    GraphExecutionEventType.WORKFLOW_CANCELLED,
  ].includes(envelope.type as GraphExecutionEventType);
}

/** Whether an envelope is the trigger's own `context.log` subscription marker. */
function isSubscriptionLog(
  envelope: GraphRunEventEnvelope,
  message: string
): boolean {
  if (envelope.type !== GraphExecutionEventType.NODE_OUTPUT) return false;
  const payload = envelope.payload as { message?: unknown } | undefined;
  return payload?.message === message;
}

/**
 * Subscribes to the run stream first, then replays already-published events,
 * resolving when the trigger logs its subscription marker.
 */
async function waitForSubscription(
  service: GraphRunService,
  run: GraphRun,
  message: string
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `run '${run.runId}' never logged '${message}' within ${TRIGGER_TIMEOUT_MS}ms`
          )
        ),
      TRIGGER_TIMEOUT_MS
    );
    const inspect = (envelope: GraphRunEventEnvelope): void => {
      if (isSubscriptionLog(envelope, message)) {
        finish();
        return;
      }
      if (isTerminalEvent(envelope)) {
        finish(
          new Error(
            `run '${run.runId}' reached ${envelope.type} before logging '${message}': ${JSON.stringify(
              envelope.error ?? envelope.payload
            )}`
          )
        );
      }
    };
    unsubscribe = service.subscribeRunEvents(run, inspect);
    void service
      .listEvents(run.runId, 0, run.ownerUser)
      .then((events) => events.forEach(inspect))
      .catch(() => undefined);
  });
}

/** Starts a trigger run and waits for its subscription marker. */
async function startTriggerRun(
  service: GraphRunService,
  document: GraphWorkflowDocument,
  owner: string,
  marker: string,
  inputs: Record<string, unknown> = {}
): Promise<GraphRun> {
  const run = await service.createRun(
    { workflow: document, inputs: inputs as never },
    owner
  );
  await waitForSubscription(service, run, marker);
  return run;
}

/** Waits for the run to finish and asserts it succeeded, surfacing the error on failure. */
async function expectSucceededRun(
  service: GraphRunService,
  run: GraphRun,
  owner: string
): Promise<GraphRun> {
  const settled = await service.waitForRun(run.runId, owner);
  expect(settled.error).toBeUndefined();
  expect(settled.status).toBe("succeeded");
  service.release(run.runId);
  return settled;
}

/** Builds a one-node trigger document that routes the payload to a workflow output. */
function streamTriggerDocument(
  id: string,
  kind: string,
  parameters: Record<string, unknown>,
  extraOutputs: Record<string, string> = {}
): GraphWorkflowDocument {
  const outputs = ["result", ...Object.values(extraOutputs)];
  const edges = [
    documentEdge("e-payload", ["node", "trigger", "payload"], ["workflow", "result"]),
    ...Object.entries(extraOutputs).map(([port, workflowPort]) =>
      documentEdge(`e-${port}`, ["node", "trigger", port], ["workflow", workflowPort])
    ),
  ];
  return {
    id,
    name: id,
    inputs: [],
    outputs: outputs.map((port) => documentPort(port)),
    nodes: [documentNode("trigger", kind, parameters)],
    edges,
  };
}

describe("core.trigger.redis (live Redis pub/sub)", () => {
  it("fires from core.storage.redis publish on the same prefixed channel", async () => {
    const service = newService();
    const owner = uniqueName("saa1452-redis-owner");
    const prefix = uniqueName("saa1452-redis");
    const payload = { source: "redis", n: 1 };
    const document = streamTriggerDocument(
      uniqueName("wf-redis"),
      "core.trigger.redis",
      {
        channels: "events",
        prefix,
        host: ENDPOINTS.redis.host,
        port: ENDPOINTS.redis.port,
        jsonParseBody: true,
        timeoutMs: TRIGGER_TIMEOUT_MS,
      },
      { channel: "channel" }
    );

    const run = await startTriggerRun(
      service,
      document,
      owner,
      "Redis trigger subscribed"
    );
    const published = await runNode(RedisNode, "core.storage.redis", {
      host: ENDPOINTS.redis.host,
      port: ENDPOINTS.redis.port,
      operation: "publish",
      channel: `${prefix}:events`,
      value: payload,
    });
    expect(published.count).toBeGreaterThanOrEqual(1);

    const settled = await expectSucceededRun(service, run, owner);
    expect(settled.result?.outputs.result).toEqual(payload);
    expect(settled.result?.outputs.channel).toBe(`${prefix}:events`);
  });

  it("fires from a wildcard channel pattern", async () => {
    const service = newService();
    const owner = uniqueName("saa1452-redis-wild-owner");
    const prefix = uniqueName("saa1452-redis-wild");
    const payload = { source: "redis-wildcard", n: 2 };
    const document = streamTriggerDocument(
      uniqueName("wf-redis-wild"),
      "core.trigger.redis",
      {
        channels: "orders.*",
        prefix,
        host: ENDPOINTS.redis.host,
        port: ENDPOINTS.redis.port,
        jsonParseBody: true,
        timeoutMs: TRIGGER_TIMEOUT_MS,
      },
      { channel: "channel" }
    );

    const run = await startTriggerRun(
      service,
      document,
      owner,
      "Redis trigger subscribed"
    );
    await runNode(RedisNode, "core.storage.redis", {
      host: ENDPOINTS.redis.host,
      port: ENDPOINTS.redis.port,
      operation: "publish",
      channel: `${prefix}:orders.created`,
      value: payload,
    });

    const settled = await expectSucceededRun(service, run, owner);
    expect(settled.result?.outputs.result).toEqual(payload);
    expect(settled.result?.outputs.channel).toBe(`${prefix}:orders.created`);
  });
});

describe("core.trigger.rabbitmq (live RabbitMQ)", () => {
  const queues: string[] = [];
  const exchanges: string[] = [];

  afterAll(async () => {
    if (!queues.length && !exchanges.length) return;
    let connection: ChannelModel | undefined;
    let channel: Channel | undefined;
    try {
      connection = await amqpConnect({
        protocol: "amqp",
        hostname: ENDPOINTS.rabbitmq.host,
        port: ENDPOINTS.rabbitmq.port,
        username: ENDPOINTS.rabbitmq.username,
        password: ENDPOINTS.rabbitmq.password,
        heartbeat: 10,
      });
      channel = await connection.createChannel();
      for (const queue of queues) {
        await channel.deleteQueue(queue).catch(() => undefined);
      }
      for (const exchange of exchanges) {
        await channel.deleteExchange(exchange).catch(() => undefined);
      }
    } finally {
      await channel?.close().catch(() => undefined);
      await connection?.close().catch(() => undefined);
    }
  });

  it("fires from core.storage.rabbitmq queue mode", async () => {
    const service = newService();
    const owner = uniqueName("saa1452-rabbit-owner");
    const queue = uniqueName("saa1452-rabbit-queue");
    queues.push(queue);
    const payload = { source: "rabbitmq-queue", n: 3 };
    const document = streamTriggerDocument(
      uniqueName("wf-rabbit"),
      "core.trigger.rabbitmq",
      {
        queue,
        host: ENDPOINTS.rabbitmq.host,
        port: ENDPOINTS.rabbitmq.port,
        username: ENDPOINTS.rabbitmq.username,
        credentialRef: RABBIT_CREDENTIAL,
        jsonParseBody: true,
        timeoutMs: TRIGGER_TIMEOUT_MS,
      },
      { queue: "queueName" }
    );

    const run = await startTriggerRun(
      service,
      document,
      owner,
      "RabbitMQ trigger subscribed"
    );
    const published = await runNode(
      RabbitMqNode,
      "core.storage.rabbitmq",
      {
        mode: "queue",
        queue,
        host: ENDPOINTS.rabbitmq.host,
        port: ENDPOINTS.rabbitmq.port,
        username: ENDPOINTS.rabbitmq.username,
        value: payload,
      },
      {},
      credential(RABBIT_CREDENTIAL, "rabbitmq")
    );
    expect(published).toEqual({ result: true, target: queue });

    const settled = await expectSucceededRun(service, run, owner);
    expect(settled.result?.outputs.result).toEqual(payload);
    expect(settled.result?.outputs.queueName).toBe(queue);
  });

  it("fires through an exchange binding and publishes in exchange mode", async () => {
    const service = newService();
    const owner = uniqueName("saa1452-rabbit-ex-owner");
    const queue = uniqueName("saa1452-rabbit-ex-queue");
    const exchange = uniqueName("saa1452-rabbit-exchange");
    const routingKey = uniqueName("saa1452-rabbit-key");
    queues.push(queue);
    exchanges.push(exchange);
    const payload = { source: "rabbitmq-exchange", n: 4 };
    const document = streamTriggerDocument(
      uniqueName("wf-rabbit-ex"),
      "core.trigger.rabbitmq",
      {
        queue,
        exchange,
        exchangeType: "topic",
        routingKey,
        host: ENDPOINTS.rabbitmq.host,
        port: ENDPOINTS.rabbitmq.port,
        username: ENDPOINTS.rabbitmq.username,
        credentialRef: RABBIT_CREDENTIAL,
        jsonParseBody: true,
        timeoutMs: TRIGGER_TIMEOUT_MS,
      },
      { queue: "queueName" }
    );

    const run = await startTriggerRun(
      service,
      document,
      owner,
      "RabbitMQ trigger subscribed"
    );
    const published = await runNode(
      RabbitMqNode,
      "core.storage.rabbitmq",
      {
        mode: "exchange",
        exchange,
        exchangeType: "topic",
        routingKey,
        host: ENDPOINTS.rabbitmq.host,
        port: ENDPOINTS.rabbitmq.port,
        username: ENDPOINTS.rabbitmq.username,
        value: payload,
      },
      {},
      credential(RABBIT_CREDENTIAL, "rabbitmq")
    );
    expect(published).toEqual({ result: true, target: exchange });

    const settled = await expectSucceededRun(service, run, owner);
    expect(settled.result?.outputs.result).toEqual(payload);
    expect(settled.result?.outputs.queueName).toBe(queue);
  });
});

describe("core.trigger.postgres (live LISTEN/NOTIFY)", () => {
  it("parses the JSON payload emitted by core.storage.postgres pg_notify", async () => {
    const service = newService();
    const owner = uniqueName("saa1452-pg-owner");
    const channel = uniqueName("saa1452_pg_channel").replace(/-/g, "_");
    const payload = { source: "postgres", n: 5 };
    const document = streamTriggerDocument(
      uniqueName("wf-pg"),
      "core.trigger.postgres",
      {
        host: ENDPOINTS.postgres.host,
        port: ENDPOINTS.postgres.port,
        database: ENDPOINTS.postgres.database,
        username: ENDPOINTS.postgres.username,
        channel,
        credentialRef: PG_CREDENTIAL,
        jsonParseBody: true,
        timeoutMs: TRIGGER_TIMEOUT_MS,
      },
      { channel: "channel" }
    );

    const run = await startTriggerRun(
      service,
      document,
      owner,
      "Postgres trigger listening"
    );
    const published = await runNode(
      PostgresNode,
      "core.storage.postgres",
      {
        host: ENDPOINTS.postgres.host,
        port: ENDPOINTS.postgres.port,
        database: ENDPOINTS.postgres.database,
        username: ENDPOINTS.postgres.username,
        sql: "SELECT pg_notify($1, $2)",
        parameters: [channel, JSON.stringify(payload)],
      },
      {},
      credential(PG_CREDENTIAL, "postgres")
    );
    expect(published.rowCount === undefined || published.rowCount >= 0).toBe(
      true
    );

    const settled = await expectSucceededRun(service, run, owner);
    expect(settled.result?.outputs.result).toEqual(payload);
    expect(settled.result?.outputs.channel).toBe(channel);
  });
});

describe("core.trigger.sse (local event stream)", () => {
  let server: Server;
  let url: string;
  let releaseEvent: (() => void) | undefined;
  const payload = { source: "sse", n: 6 };

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      releaseEvent = () => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve())
    );
    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}/events`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fires on the first Server-Sent Event", async () => {
    const service = newService();
    const owner = uniqueName("saa1452-sse-owner");
    const document = streamTriggerDocument(
      uniqueName("wf-sse"),
      "core.trigger.sse",
      {
        url,
        jsonParseBody: true,
        timeoutMs: TRIGGER_TIMEOUT_MS,
      },
      { event: "eventName", id: "eventId" }
    );

    const run = await startTriggerRun(
      service,
      document,
      owner,
      "SSE trigger connected"
    );
    expect(releaseEvent).toBeDefined();
    releaseEvent?.();

    const settled = await expectSucceededRun(service, run, owner);
    expect(settled.result?.outputs.result).toEqual(payload);
    expect(settled.result?.outputs.eventName).toBe("message");
  });
});

describe("core.trigger.error (in-process failure context)", () => {
  it("projects the workflow-input failure context into the run outputs", async () => {
    const service = newService();
    const owner = uniqueName("saa1452-error-owner");
    const failure = {
      execution: {
        id: "exec-live",
        lastNodeExecuted: "core.io.httpRequest",
        error: { message: "upstream exploded", name: "HttpError" },
      },
      workflow: { id: "wf-upstream", name: "Upstream" },
    };
    const document: GraphWorkflowDocument = {
      id: uniqueName("wf-error"),
      name: "wf-error",
      inputs: [documentPort("payload")],
      outputs: [
        documentPort("result"),
        documentPort("execution"),
        documentPort("workflow"),
        documentPort("error"),
      ],
      nodes: [documentNode("trigger", "core.trigger.error")],
      edges: [
        documentEdge(
          "e-in",
          ["workflow", "payload"],
          ["node", "trigger", "payload"]
        ),
        documentEdge(
          "e-payload",
          ["node", "trigger", "payload"],
          ["workflow", "result"]
        ),
        documentEdge(
          "e-execution",
          ["node", "trigger", "execution"],
          ["workflow", "execution"]
        ),
        documentEdge(
          "e-workflow",
          ["node", "trigger", "workflow"],
          ["workflow", "workflow"]
        ),
        documentEdge(
          "e-error",
          ["node", "trigger", "error"],
          ["workflow", "error"]
        ),
      ],
    };

    const run = await service.createRun(
      { workflow: document, inputs: { payload: failure } },
      owner
    );
    const settled = await expectSucceededRun(service, run, owner);
    expect(settled.result?.outputs.result).toEqual(failure);
    expect(settled.result?.outputs.execution).toEqual(failure.execution);
    expect(settled.result?.outputs.workflow).toEqual(failure.workflow);
    expect(settled.result?.outputs.error).toEqual(
      failure.execution.error
    );
  });
});

describe("core.trigger.workflow (in-process lifecycle event)", () => {
  it("normalizes the workflow-input event and emits the n8n payload fields", async () => {
    const service = newService();
    const owner = uniqueName("saa1452-workflow-owner");
    const timestamp = "2026-02-03T04:05:06.000Z";
    const workflowId = "wf-lifecycle";
    const document: GraphWorkflowDocument = {
      id: uniqueName("wf-workflow-trigger"),
      name: "wf-workflow-trigger",
      inputs: [
        documentPort("event"),
        documentPort("timestamp"),
        documentPort("workflowId"),
      ],
      outputs: [documentPort("result"), documentPort("eventOut")],
      nodes: [
        documentNode("trigger", "core.trigger.workflow", {
          events: ["activate", "update"],
        }),
      ],
      edges: [
        documentEdge(
          "e-event",
          ["workflow", "event"],
          ["node", "trigger", "event"]
        ),
        documentEdge(
          "e-timestamp",
          ["workflow", "timestamp"],
          ["node", "trigger", "timestamp"]
        ),
        documentEdge(
          "e-workflow-id",
          ["workflow", "workflowId"],
          ["node", "trigger", "workflowId"]
        ),
        documentEdge(
          "e-payload",
          ["node", "trigger", "payload"],
          ["workflow", "result"]
        ),
        documentEdge(
          "e-event-out",
          ["node", "trigger", "event"],
          ["workflow", "eventOut"]
        ),
      ],
    };

    const run = await service.createRun(
      {
        workflow: document,
        inputs: {
          event: "Workflow updated",
          timestamp,
          workflowId,
        },
      },
      owner
    );
    const settled = await expectSucceededRun(service, run, owner);
    expect(settled.result?.outputs.result).toEqual({
      event: "Workflow updated",
      timestamp,
      workflow_id: workflowId,
    });
    expect(settled.result?.outputs.eventOut).toBe("update");
  });
});
