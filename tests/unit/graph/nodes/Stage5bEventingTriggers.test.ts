/**
 * @module as-graph/tests/unit/graph/nodes/Stage5bEventingTriggers.test
 * @summary Unit coverage for the Stage 5b eventing trigger kinds and the
 * RabbitMQ producer node (SAA-1452).
 * @description Exercises each of the seven new built-in kinds through the
 * production instantiation contract (`executeNode` / `runNode`): manifest
 * shape, credential/i18n contract, configuration validation error codes, the
 * shared timeout/abort wait contract, and the pure payload projections of the
 * error and workflow triggers. No live infrastructure is contacted; the live
 * stream pairing is covered by the integration suites.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
  ErrorTriggerNode,
  PostgresTriggerNode,
  RabbitMqNode,
  RabbitMqTriggerNode,
  RedisTriggerNode,
  SseTriggerNode,
  WorkflowTriggerNode,
} from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import type { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import type { GraphExecutionContext } from "../../../../src/engine/execution/GraphExecutionContext";
import {
  DEFAULT_TRIGGER_TIMEOUT_MS,
  triggerPayload,
  triggerTimeoutMs,
  waitForTriggerEvent,
} from "../../../../src/node/triggers/support";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

/** A manifest + credential/i18n expectation for one of the seven new kinds. */
interface KindContract {
  kind: string;
  nodeClass: Parameters<typeof graphNodeManifest>[0];
  category: "Trigger" | "Storage";
  credentialType?: string;
  i18n: [string, string];
  inputs: string[];
  outputs: string[];
}

const CONTRACTS: KindContract[] = [
  {
    kind: "core.trigger.redis",
    nodeClass: RedisTriggerNode,
    category: "Trigger",
    credentialType: "redis",
    i18n: ["trigger", "redis"],
    inputs: [
      "channels",
      "host",
      "port",
      "username",
      "database",
      "tls",
      "prefix",
      "jsonParseBody",
      "timeoutMs",
    ],
    outputs: ["payload", "message", "channel"],
  },
  {
    kind: "core.trigger.rabbitmq",
    nodeClass: RabbitMqTriggerNode,
    category: "Trigger",
    credentialType: "rabbitmq",
    i18n: ["trigger", "rabbitmq"],
    inputs: [
      "queue",
      "exchange",
      "exchangeType",
      "routingKey",
      "host",
      "port",
      "username",
      "vhost",
      "ssl",
      "jsonParseBody",
      "timeoutMs",
    ],
    outputs: ["payload", "message", "queue", "properties"],
  },
  {
    kind: "core.trigger.sse",
    nodeClass: SseTriggerNode,
    category: "Trigger",
    credentialType: "token",
    i18n: ["trigger", "sse"],
    inputs: ["url", "jsonParseBody", "timeoutMs"],
    outputs: ["payload", "message", "event", "id"],
  },
  {
    kind: "core.trigger.error",
    nodeClass: ErrorTriggerNode,
    category: "Trigger",
    i18n: ["trigger", "error"],
    inputs: ["payload"],
    outputs: ["payload", "execution", "workflow", "error"],
  },
  {
    kind: "core.trigger.workflow",
    nodeClass: WorkflowTriggerNode,
    category: "Trigger",
    i18n: ["trigger", "workflow"],
    inputs: ["events", "event", "payload", "timestamp", "workflowId"],
    outputs: ["payload", "event", "timestamp", "workflowId"],
  },
  {
    kind: "core.trigger.postgres",
    nodeClass: PostgresTriggerNode,
    category: "Trigger",
    credentialType: "postgres",
    i18n: ["trigger", "postgres"],
    inputs: [
      "host",
      "port",
      "database",
      "username",
      "channel",
      "ssl",
      "acceptSelfSigned",
      "jsonParseBody",
      "timeoutMs",
    ],
    outputs: ["payload", "message", "channel"],
  },
  {
    kind: "core.storage.rabbitmq",
    nodeClass: RabbitMqNode,
    category: "Storage",
    credentialType: "rabbitmq",
    i18n: ["storage", "rabbitmq"],
    inputs: [
      "mode",
      "queue",
      "exchange",
      "exchangeType",
      "routingKey",
      "host",
      "port",
      "username",
      "vhost",
      "ssl",
      "value",
    ],
    outputs: ["result", "target"],
  },
];

/** The English catalogue the manifests' locale keys resolve against. */
const I18N = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../assets/i18n/en.json"), "utf8")
) as Record<string, unknown>;

/** Resolves a dotted locale key against the English catalogue. */
function i18nValue(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[part]
          : undefined,
      I18N
    );
}

/** Runs a node call and returns its `graphCode`, or the thrown message when uncoded. */
async function graphCodeOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as GraphExecutionError).graphCode;
  }
  return undefined;
}

/** A context double carrying an already-aborted run signal. */
function abortedContext(): GraphExecutionContext {
  const controller = new AbortController();
  controller.abort();
  return {
    abortSignal: controller.signal,
    log: async () => undefined,
  } as unknown as GraphExecutionContext;
}

/** A context double whose run signal never aborts. */
function openContext(): GraphExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    log: async () => undefined,
  } as unknown as GraphExecutionContext;
}

describe("Stage 5b eventing triggers — manifests", () => {
  it.each(CONTRACTS)("$kind declares its kind, category, and ports", (entry) => {
    const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[entry.kind];
    expect(manifest.kind).toBe(entry.kind);
    expect(manifest.display.category).toBe(entry.category);
    expect(manifest.inputs.map((port) => port.id)).toEqual(entry.inputs);
    expect(manifest.outputs.map((port) => port.id)).toEqual(entry.outputs);
  });

  it.each(CONTRACTS.filter((entry) => entry.credentialType))(
    "$kind declares its optional credential reference",
    (entry) => {
      const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[entry.kind];
      expect(manifest.credentials).toEqual(
        expect.arrayContaining([
          { type: entry.credentialType, required: false },
        ])
      );
      expect(
        manifest.parameters.find((parameter) => parameter.id === "credentialRef")
      ).toMatchObject({
        type: "credential",
        required: false,
        credentialType: entry.credentialType,
      });
    }
  );

  it.each(CONTRACTS.filter((entry) => !entry.credentialType))(
    "$kind declares no credential reference",
    (entry) => {
      const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[entry.kind];
      expect(manifest.credentials ?? []).toHaveLength(0);
      expect(
        manifest.parameters.some(
          (parameter) => parameter.id === "credentialRef"
        )
      ).toBe(false);
    }
  );
});

describe("Stage 5b eventing triggers — i18n contract", () => {
  it.each(CONTRACTS)("$kind resolves its name, description, and field labels", (entry) => {
    const [category, section] = entry.i18n;
    const block = i18nValue(`graph.node.${category}.${section}`) as
      | { name?: unknown; description?: unknown; fields?: Record<string, unknown> }
      | undefined;
    expect(block).toBeDefined();
    expect(typeof block?.name).toBe("string");
    expect((block?.name as string).length).toBeGreaterThan(0);
    expect(typeof block?.description).toBe("string");
    expect((block?.description as string).length).toBeGreaterThan(0);

    const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[entry.kind];
    expect(i18nValue(`graph.node.${category}.${section}.name`)).toBe(
      block?.name
    );

    const localeKeys = new Set<string>();
    if (manifest.display.description?.startsWith("graph.")) {
      localeKeys.add(manifest.display.description);
    }
    for (const parameter of manifest.parameters) {
      if (parameter.label?.startsWith("graph.")) localeKeys.add(parameter.label);
      const placeholder = (parameter as { placeholder?: unknown }).placeholder;
      if (typeof placeholder === "string" && placeholder.startsWith("graph.")) {
        localeKeys.add(placeholder);
      }
      for (const port of [
        ...manifest.inputs,
        ...manifest.outputs,
      ]) {
        const label = (port.element?.props as Record<string, unknown> | undefined)?.[
          "label"
        ];
        if (typeof label === "string" && label.startsWith("graph.")) {
          localeKeys.add(label);
        }
      }
    }
    expect(localeKeys.size).toBeGreaterThan(0);
    for (const key of localeKeys) {
      expect(typeof i18nValue(key)).toBe("string");
      expect((i18nValue(key) as string).length).toBeGreaterThan(0);
    }
  });
});

describe("Stage 5b eventing triggers — configuration validation", () => {
  it("requires at least one Redis channel", async () => {
    for (const parameters of [{}, { channels: "   " }, { channels: "," }]) {
      const context = buildNodeContext("core.trigger.redis", { parameters });
      expect(
        await graphCodeOf(() =>
          executeNode(
            RedisTriggerNode,
            nodeExecutionRequest({}),
            context
          )
        )
      ).toBe("GRAPH_REDIS_TRIGGER_CHANNELS_REQUIRED");
    }
  });

  it("requires a RabbitMQ trigger queue", async () => {
    const context = buildNodeContext("core.trigger.rabbitmq");
    expect(
      await graphCodeOf(() =>
        executeNode(RabbitMqTriggerNode, nodeExecutionRequest({}), context)
      )
    ).toBe("GRAPH_RABBITMQ_TRIGGER_QUEUE_REQUIRED");
  });

  it("requires a valid SSE URL", async () => {
    const missing = buildNodeContext("core.trigger.sse");
    expect(
      await graphCodeOf(() =>
        executeNode(SseTriggerNode, nodeExecutionRequest({}), missing)
      )
    ).toBe("GRAPH_SSE_TRIGGER_URL_REQUIRED");

    const invalid = buildNodeContext("core.trigger.sse", {
      parameters: { url: "not a url" },
    });
    expect(
      await graphCodeOf(() =>
        executeNode(SseTriggerNode, nodeExecutionRequest({}), invalid)
      )
    ).toBe("GRAPH_SSE_TRIGGER_URL_INVALID");
  });

  it("requires a valid Postgres channel and connection settings", async () => {
    const missingChannel = buildNodeContext("core.trigger.postgres", {
      parameters: {
        database: "test",
        username: "postgres",
      },
    });
    expect(
      await graphCodeOf(() =>
        executeNode(
          PostgresTriggerNode,
          nodeExecutionRequest({}),
          missingChannel
        )
      )
    ).toBe("GRAPH_POSTGRES_TRIGGER_CHANNEL_REQUIRED");

    const invalidChannel = buildNodeContext("core.trigger.postgres", {
      parameters: {
        channel: "1bad-channel",
        database: "test",
        username: "postgres",
      },
    });
    expect(
      await graphCodeOf(() =>
        executeNode(
          PostgresTriggerNode,
          nodeExecutionRequest({}),
          invalidChannel
        )
      )
    ).toBe("GRAPH_POSTGRES_TRIGGER_CHANNEL_INVALID");

    const missingConnection = buildNodeContext("core.trigger.postgres", {
      parameters: { channel: "valid_channel" },
    });
    expect(
      await graphCodeOf(() =>
        executeNode(
          PostgresTriggerNode,
          nodeExecutionRequest({}),
          missingConnection
        )
      )
    ).toBe("GRAPH_POSTGRES_TRIGGER_CONNECTION_REQUIRED");
  });

  it("requires the RabbitMQ producer target for the selected mode", async () => {
    const queueMode = buildNodeContext("core.storage.rabbitmq", {
      parameters: { mode: "queue" },
    });
    expect(
      await graphCodeOf(() =>
        executeNode(RabbitMqNode, nodeExecutionRequest({}), queueMode)
      )
    ).toBe("GRAPH_RABBITMQ_QUEUE_REQUIRED");

    const exchangeMode = buildNodeContext("core.storage.rabbitmq", {
      parameters: { mode: "exchange" },
    });
    expect(
      await graphCodeOf(() =>
        executeNode(RabbitMqNode, nodeExecutionRequest({}), exchangeMode)
      )
    ).toBe("GRAPH_RABBITMQ_EXCHANGE_REQUIRED");
  });
});

describe("Stage 5b eventing triggers — shared wait contract", () => {
  it("defaults the wait budget to 30s and honours a positive override", () => {
    expect(DEFAULT_TRIGGER_TIMEOUT_MS).toBe(30_000);
    expect(triggerTimeoutMs(undefined)).toBe(30_000);
    expect(triggerTimeoutMs(0)).toBe(30_000);
    expect(triggerTimeoutMs(-5)).toBe(30_000);
    expect(triggerTimeoutMs("250")).toBe(250);
    expect(triggerTimeoutMs(12.9)).toBe(12);
  });

  it("projects JSON payloads when requested and falls back to the raw string", () => {
    expect(triggerPayload('{"a":1}', true)).toEqual({ a: 1 });
    expect(triggerPayload("not-json", true)).toBe("not-json");
    expect(triggerPayload('{"a":1}', false)).toBe('{"a":1}');
  });

  it("fails with GRAPH_TRIGGER_TIMEOUT and runs cleanup when no event arrives", async () => {
    let cleaned = false;
    await expect(
      waitForTriggerEvent(
        openContext(),
        10,
        async () => () => {
          cleaned = true;
        },
        "GRAPH_TRIGGER_TIMEOUT",
        "no event"
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_TRIGGER_TIMEOUT" });
    expect(cleaned).toBe(true);
  });

  it("fails with GRAPH_TRIGGER_ABORTED for an already-aborted run signal", async () => {
    let subscribed = false;
    await expect(
      waitForTriggerEvent(
        abortedContext(),
        1_000,
        async () => {
          subscribed = true;
          return () => undefined;
        },
        "GRAPH_TRIGGER_TIMEOUT",
        "no event"
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_TRIGGER_ABORTED" });
    expect(subscribed).toBe(false);
  });

  it("resolves the first emitted event and still runs cleanup", async () => {
    let cleaned = false;
    const event = await waitForTriggerEvent(
      openContext(),
      1_000,
      async (emit) => {
        emit({ message: "first" });
        return () => {
          cleaned = true;
        };
      },
      "GRAPH_TRIGGER_TIMEOUT",
      "no event"
    );
    expect(event).toEqual({ message: "first" });
    expect(cleaned).toBe(true);
  });
});

describe("core.trigger.error — failure projections", () => {
  it("projects execution, workflow, and error from the delivered payload", async () => {
    const payload = {
      execution: {
        id: "exec-1",
        lastNodeExecuted: "core.io.httpRequest",
        error: { message: "boom", name: "HttpError" },
      },
      workflow: { id: "wf-1", name: "Orders" },
    };
    const context = buildNodeContext("core.trigger.error");
    const result = await executeNode(
      ErrorTriggerNode,
      nodeExecutionRequest({ payload }),
      context
    );
    expect(result).toEqual({
      payload,
      execution: payload.execution,
      workflow: payload.workflow,
      error: payload.execution.error,
    });
  });

  it("falls back to the whole input map when no payload is bound", async () => {
    const context = buildNodeContext("core.trigger.error");
    const result = await executeNode(
      ErrorTriggerNode,
      nodeExecutionRequest({ reason: "unbound", attempt: 2 }),
      context
    );
    expect(result.payload).toEqual({ reason: "unbound", attempt: 2 });
    expect(result.execution).toBeUndefined();
    expect(result.workflow).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("wraps a scalar delivered payload under value", async () => {
    const context = buildNodeContext("core.trigger.error");
    const result = await executeNode(
      ErrorTriggerNode,
      nodeExecutionRequest({ payload: "fatal" }),
      context
    );
    expect(result.payload).toEqual({ value: "fatal" });
  });

  it("accepts execution/workflow/error blocks delivered as separate inputs", async () => {
    const context = buildNodeContext("core.trigger.error");
    const result = await executeNode(
      ErrorTriggerNode,
      nodeExecutionRequest({
        execution: { id: "exec-2", error: { message: "nested" } },
        workflow: { id: "wf-2" },
        error: { message: "top-level" },
      }),
      context
    );
    expect(result.execution).toMatchObject({ id: "exec-2" });
    expect(result.workflow).toMatchObject({ id: "wf-2" });
    expect(result.error).toEqual({ message: "nested" });
  });
});

describe("core.trigger.workflow — lifecycle event normalization", () => {
  it("defaults to the first configured event and emits the lifecycle payload", async () => {
    const context = buildNodeContext("core.trigger.workflow", {
      parameters: { events: ["activate"] },
    });
    const before = Date.now();
    const result = await executeNode(
      WorkflowTriggerNode,
      nodeExecutionRequest({}),
      context
    );
    expect(result.event).toBe("activate");
    expect(result.payload).toMatchObject({ event: "Workflow activated" });
    const timestamp = result.timestamp as string;
    expect(Number.isFinite(Date.parse(timestamp))).toBe(true);
    expect(Date.parse(timestamp)).toBeGreaterThanOrEqual(before - 1_000);
    expect(result.workflowId).toBeUndefined();
  });

  it("normalizes n8n event labels and carries the workflow id", async () => {
    const context = buildNodeContext("core.trigger.workflow", {
      parameters: { events: ["activate", "update"] },
    });
    const result = await executeNode(
      WorkflowTriggerNode,
      nodeExecutionRequest({
        event: "Workflow updated",
        timestamp: "2026-01-02T03:04:05.000Z",
        workflowId: "wf-42",
      }),
      context
    );
    expect(result.event).toBe("update");
    expect(result.timestamp).toBe("2026-01-02T03:04:05.000Z");
    expect(result.workflowId).toBe("wf-42");
    expect(result.payload).toEqual({
      event: "Workflow updated",
      timestamp: "2026-01-02T03:04:05.000Z",
      workflow_id: "wf-42",
    });
  });

  it("passes a delivered lifecycle payload through and reads its fields", async () => {
    const payload = {
      event: "activate",
      timestamp: "2026-05-06T07:08:09.000Z",
      workflow_id: "wf-7",
    };
    const context = buildNodeContext("core.trigger.workflow", {
      parameters: { events: ["activate"] },
    });
    const result = await executeNode(
      WorkflowTriggerNode,
      nodeExecutionRequest({ payload }),
      context
    );
    expect(result.payload).toBe(payload);
    expect(result.event).toBe("activate");
    expect(result.timestamp).toBe("2026-05-06T07:08:09.000Z");
    expect(result.workflowId).toBe("wf-7");
  });

  it("fails closed for an unsupported or unconfigured delivered event", async () => {
    const unconfigured = buildNodeContext("core.trigger.workflow", {
      parameters: { events: ["activate"] },
    });
    expect(
      await graphCodeOf(() =>
        executeNode(
          WorkflowTriggerNode,
          nodeExecutionRequest({ event: "update" }),
          unconfigured
        )
      )
    ).toBe("GRAPH_WORKFLOW_TRIGGER_EVENT_NOT_CONFIGURED");

    const invalid = buildNodeContext("core.trigger.workflow", {
      parameters: { events: ["activate"] },
    });
    expect(
      await graphCodeOf(() =>
        executeNode(
          WorkflowTriggerNode,
          nodeExecutionRequest({ event: "delete" }),
          invalid
        )
      )
    ).toBe("GRAPH_WORKFLOW_TRIGGER_EVENT_INVALID");
  });
});
