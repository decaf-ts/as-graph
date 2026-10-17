/**
 * @module as-graph/tests/integration/mastra/MastraMemoryDriverRun
 * @summary SAA-838 M2 integration: an agent node wired with a `core.agent.memory`
 * provider on its `memory` connection zone resolves a live mastra-native
 * `Memory` at the agent factory and binds the generate call to the configured
 * conversation thread through mastra's per-run `memory` option.
 * @description Real: the production `MastraGraphExecutionBackend`, the
 * production `MastraWorkflowCompiler`, `createMastraDefaultStepHandlers` (real
 * `@mastra/core` `createStep`), the real `@mastra/memory` `Memory` where the
 * assertion needs actual memory behavior, and a real mastra run. Host-injected:
 * the frame-bound event sink and a fake agent factory that records the resolved
 * memories and its generate options (real mastra generate needs a model key and
 * is not required for the wiring assertions).
 *
 * Coverage (SAA-838 M2 driver tests):
 * 1. memory port wiring end to end (live `Memory` at the factory + thread binding),
 * 2. the R9 JSON-safe descriptor (node `resource` output, JSON round-trip) and
 *    the config-only fallback via the backend `memories` map,
 * 3. the fail-closed paths (`GRAPH_MASTRA_MEMORY_UNAVAILABLE` /
 *    `GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN`),
 * 4. the R8 no-driver on-demand path (libsql over a local file, no external
 *    database service),
 * 5. mastra memory semantics over repeated runs on the same thread (conversation
 *    history, semantic-recall option mapping, working-memory template merge),
 * 6. the `core.agent.memorySelector` decision shape.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { Memory } from "@mastra/memory";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { createMastraDefaultStepHandlers } from "../../../src/mastra/MastraDefaultStepHandlers";
import {
  mastraMemoryDescriptorOf,
  mastraMemoryOptionsOf,
  resolveMastraMemory,
  resolveMastraMemoryStorage,
  type MastraMemoryConfig,
} from "../../../src/mastra/MastraMemory";
import {
  GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN,
  GRAPH_MASTRA_MEMORY_UNAVAILABLE,
} from "../../../src/mastra/types";
import {
  GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
  GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED,
} from "../../../src/mastra/MastraEnvironment";
import type { MastraBackendConfig, MastraNodeStepHandler } from "../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { document, edge, node } from "../../../src/workflows/builders";
import { frameSinkHarness, rejectionGraphCodeOf, type FrameSinkHarness } from "./helpers";

/** Boots the mastra host over the supplied backend config. */
async function bootHost(config: MastraBackendConfig) {
  return createGraphBackendHost({ variant: "mastra", mastra: config });
}

/** The test-only environment variable carrying the pg credential value. */
const ENV_PASSWORD_OVERRIDE = "MASTRA_TEST_MEMORY_PG_PASSWORD";

/** The per-run generate options the fake agent records. */
interface RecordedGenerateOptions {
  memory?: { thread: string; resource?: string };
}

/** One recorded generate invocation of the fake agent. */
interface RecordedGenerateCall {
  prompt: string;
  options?: RecordedGenerateOptions;
}

/** The resolved memories a fake agent factory receives, plus its generate calls. */
interface RecordingAgentFactory {
  factoryMemories: Array<readonly unknown[] | undefined>;
  calls: RecordedGenerateCall[];
  createAgent: (
    adapter: unknown,
    agentNode: unknown,
    memories?: readonly unknown[]
  ) => {
    generate: (
      prompt: string,
      options?: RecordedGenerateOptions
    ) => Promise<{ text: string; toolCalls: unknown[] }>;
  };
}

/**
 * A fake agent factory that records the resolved memories handed to it (mastra
 * attaches live memory at construction only) and every generate call's options.
 */
function recordingAgentFactory(): RecordingAgentFactory {
  const factoryMemories: Array<readonly unknown[] | undefined> = [];
  const calls: RecordedGenerateCall[] = [];
  return {
    factoryMemories,
    calls,
    createAgent: (_adapter, _agentNode, memories) => {
      factoryMemories.push(memories);
      return {
        generate: async (prompt, options) => {
          calls.push({ prompt, options });
          return { text: `echo:${prompt}`, toolCalls: [] };
        },
      };
    },
  };
}

/** An agent wired with one `core.agent.memory` provider on its `memory` zone. */
function memoryWiredDocument(
  id: string,
  memoryParameters: Record<string, unknown>
): GraphWorkflowDocument {
  return document({
    id,
    name: id,
    nodes: [
      node("chat", "core.trigger.chat"),
      node("agent", "core.agent"),
      node("mem", "core.agent.memory", memoryParameters),
    ],
    edges: [
      edge("e1", ["node", "chat", "message"], ["node", "agent", "prompt"]),
      edge("e2", ["node", "mem", "memory"], ["node", "agent", "memory"], "connection"),
    ],
  });
}

/** Runs a document through the real backend and returns the run result. */
async function runDocument(
  config: MastraBackendConfig,
  document: GraphWorkflowDocument,
  harness: FrameSinkHarness,
  inputs: Record<string, unknown> = {}
) {
  const host = await bootHost(config);
  const backend = host.backend!;
  return backend.execute({
    document,
    plan: {} as never,
    inputs,
    options: {} as never,
    events: harness.sink,
  });
}

/** Finds the recorded `node.completed` outputs for a node id. */
function completedOutputs(
  harness: FrameSinkHarness,
  nodeId: string
): Record<string, unknown> | undefined {
  const payload = harness.events.find(
    (event) =>
      event.type === GraphExecutionEventType.NODE_COMPLETED &&
      event.nodeId === nodeId
  )?.payload as { outputs?: Record<string, unknown> } | undefined;
  return payload?.outputs;
}

/** Finds the recorded `node.failed` error payload for a node id. */
function failedError(
  harness: FrameSinkHarness,
  nodeId: string
): { name?: string; message?: string; code?: string } | undefined {
  return harness.events.find(
    (event) =>
      event.type === GraphExecutionEventType.NODE_FAILED &&
      event.nodeId === nodeId
  )?.error as { name?: string; message?: string; code?: string } | undefined;
}

/**
 * A host step handler that emits the run's `decision` input on a `decision`
 * output port, so the routed value reaches the selector's step input under the
 * key its executor reads. This is the same host-injected seam the other
 * integration suites use for deterministic leaf values.
 */
function decisionSourceStepHandler(): MastraNodeStepHandler {
  return {
    kind: "test.memoryDecisionSource",
    createStep: (_node, { stepId }) =>
      createStep({
        id: stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: { inputData?: unknown }) => {
          const value = (args.inputData ?? {}) as Record<string, unknown>;
          return { decision: value["decision"] };
        },
      }),
  };
}

/** Temp directory for the R8 libsql on-demand file test (removed in afterAll). */
let libsqlDir: string;

beforeAll(() => {
  libsqlDir = mkdtempSync(join(tmpdir(), "mastra-memory-driver-"));
});

afterAll(() => {
  if (libsqlDir) rmSync(libsqlDir, { recursive: true, force: true });
});

describe("mastra memory driver run — memory port wiring (SAA-838 M2)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("resolves the wired live Memory at the agent factory and binds the thread on generate", async () => {
    const fake = recordingAgentFactory();
    const harness = frameSinkHarness("saa-838-memory-wiring-run");

    const result = await runDocument(
      {
        mastra: {},
        stepHandlers: createMastraDefaultStepHandlers(),
        createAgent: fake.createAgent,
      },
      memoryWiredDocument("saa-838-memory-wiring-run", {
        provider: "memory",
        threadId: "thread-1",
        resourceId: "res-1",
      }),
      harness,
      { message: "summarise the brief" }
    );

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);

    // The agent factory received the resolved live mastra-native Memory
    // (mastra attaches live memory at construction only).
    expect(fake.factoryMemories).toHaveLength(1);
    const memories = fake.factoryMemories[0];
    expect(memories).toHaveLength(1);
    expect(memories?.[0]).toBeInstanceOf(Memory);

    // The generate call carries mastra's per-run memory option from the wired
    // config: the thread (and resource id) the invocation binds to.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].options?.memory).toEqual({
      thread: "thread-1",
      resource: "res-1",
    });
    expect(
      harness.events.some(
        (event) => event.type === GraphExecutionEventType.WORKFLOW_COMPLETED
      )
    ).toBe(true);
  });

  it("falls back to the backend memories map by provider key (config-only fallback)", async () => {
    // A memory surface declared without a memory id resolves through the
    // provider key; the host owns the live memory, so the built-in resolver
    // must not be consulted.
    const byProvider = recordingAgentFactory();
    const providerMemory = { tagged: "host-memory-by-provider" };
    const byProviderHarness = frameSinkHarness("saa-838-memory-by-provider-run");
    const byProviderResult = await runDocument(
      {
        mastra: {},
        stepHandlers: createMastraDefaultStepHandlers(),
        createAgent: byProvider.createAgent,
        memories: { memory: providerMemory },
      },
      memoryWiredDocument("saa-838-memory-by-provider-run", {
        provider: "memory",
        threadId: "thread-1",
      }),
      byProviderHarness,
      { message: "hello" }
    );
    expect(byProviderResult.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(byProvider.factoryMemories[0]).toEqual([providerMemory]);
  });

  it("falls back to the backend memories map by config id", async () => {
    const byId = recordingAgentFactory();
    const hostMemory = { tagged: "host-memory-by-id" };
    const byIdHarness = frameSinkHarness("saa-838-memory-by-id-run");
    const byIdResult = await runDocument(
      {
        mastra: {},
        stepHandlers: createMastraDefaultStepHandlers(),
        createAgent: byId.createAgent,
        memories: { "chief-memory": hostMemory },
      },
      memoryWiredDocument("saa-838-memory-by-id-run", {
        provider: "memory",
        memoryId: "chief-memory",
        threadId: "thread-1",
      }),
      byIdHarness,
      { message: "hello" }
    );
    expect(byIdResult.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(byId.factoryMemories[0]).toEqual([hostMemory]);
  });
});

describe("mastra memory driver run — R9 descriptor (SAA-838 M2)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("emits the JSON-safe, secret-free descriptor on the resource output", async () => {
    const harness = frameSinkHarness("saa-838-memory-descriptor-run");

    const result = await runDocument(
      { mastra: {}, stepHandlers: createMastraDefaultStepHandlers() },
      document({
        id: "saa-838-memory-descriptor-run",
        name: "saa-838-memory-descriptor-run",
        nodes: [
          node("mem", "core.agent.memory", {
            provider: "libsql",
            memoryId: "chief",
            threadId: "thread-1",
            resourceId: "res-1",
            lastMessages: 10,
            semanticRecall: false,
            workingMemoryTemplate: "Preferred language: {{language}}",
            generateTitle: false,
            connection: { url: "file:./secret-free-descriptor.db" },
          }),
        ],
      }),
      harness
    );

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    const descriptor = completedOutputs(harness, "mem")?.["resource"] as Record<
      string,
      unknown
    >;
    expect(descriptor).toMatchObject({
      type: "mastra.memory",
      provider: "libsql",
      threadId: "thread-1",
      resourceId: "res-1",
      lastMessages: 10,
      semanticRecall: false,
      workingMemory: { enabled: true, template: "Preferred language: {{language}}" },
      generateTitle: false,
    });
    expect(typeof descriptor["id"]).toBe("string");
    // JSON-safe (round-trips) and secret-free: no live objects, no connection
    // values, no credential material.
    const roundTripped = JSON.parse(JSON.stringify(descriptor));
    expect(roundTripped).toEqual(descriptor);
    expect(descriptor).not.toHaveProperty("connection");
    expect(JSON.stringify(descriptor)).not.toContain("file:./secret-free-descriptor.db");
  });

  it("carries the configured memoryId in the descriptor id", async () => {
    const harness = frameSinkHarness("saa-838-memory-descriptor-id-run");
    await runDocument(
      { mastra: {}, stepHandlers: createMastraDefaultStepHandlers() },
      document({
        id: "saa-838-memory-descriptor-id-run",
        name: "saa-838-memory-descriptor-id-run",
        nodes: [
          node("mem", "core.agent.memory", {
            provider: "libsql",
            memoryId: "chief",
          }),
        ],
      }),
      harness
    );
    const descriptor = completedOutputs(harness, "mem")?.["resource"] as {
      id?: string;
    };
    expect(descriptor.id).toBe("chief");
  });
});

describe("mastra memory driver run — fail-closed paths (SAA-838 M2)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("fails closed for libsql without a connection url", async () => {
    const graphCode = await rejectionGraphCodeOf(() =>
      resolveMastraMemoryStorage(
        { provider: "libsql", connection: {} } as MastraMemoryConfig,
        "mem"
      )
    );
    expect(graphCode).toBe(GRAPH_MASTRA_MEMORY_UNAVAILABLE);
  });

  it("fails closed for pg without a complete non-secret host config", async () => {
    const graphCode = await rejectionGraphCodeOf(() =>
      resolveMastraMemoryStorage(
        { provider: "pg", connection: { host: "localhost" } } as MastraMemoryConfig,
        "mem"
      )
    );
    expect(graphCode).toBe(GRAPH_MASTRA_MEMORY_UNAVAILABLE);
  });

  it("refuses plaintext pg credential material in the connection options (SAA-911 F4)", async () => {
    for (const key of ["connectionString", "password"]) {
      const graphCode = await rejectionGraphCodeOf(() =>
        resolveMastraMemoryStorage(
          {
            provider: "pg",
            connection: {
              host: "localhost",
              port: 5432,
              database: "db",
              user: "u",
              [key]: "plaintext-secret",
            },
            credentialRef: { credentialId: "MASTRA_PG_PASSWORD", credentialType: "pg" },
          } as unknown as MastraMemoryConfig,
          "mem"
        )
      );
      expect(graphCode).toBe(GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED);
    }
  });

  it("fails closed for pg without a credentialRef (SAA-911 F4)", async () => {
    const graphCode = await rejectionGraphCodeOf(() =>
      resolveMastraMemoryStorage(
        {
          provider: "pg",
          connection: { host: "localhost", port: 5432, database: "db", user: "u" },
        } as MastraMemoryConfig,
        "mem"
      )
    );
    expect(graphCode).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);
  });

  it("fails closed for pg whose referenced credential is unset (SAA-911 F4)", async () => {
    const graphCode = await rejectionGraphCodeOf(() =>
      resolveMastraMemoryStorage(
        {
          provider: "pg",
          connection: { host: "localhost", port: 5432, database: "db", user: "u" },
          credentialRef: { credentialId: ENV_PASSWORD_OVERRIDE, credentialType: "pg" },
        } as MastraMemoryConfig,
        "mem"
      )
    );
    expect(graphCode).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);
  });

  it("resolves the pg credential by name into the store options only (SAA-911 F4)", async () => {
    process.env[ENV_PASSWORD_OVERRIDE] = "resolved-pg-secret";
    try {
      const store = await resolveMastraMemoryStorage(
        {
          provider: "pg",
          connection: { host: "localhost", port: 5432, database: "db", user: "u" },
          credentialRef: { credentialId: ENV_PASSWORD_OVERRIDE, credentialType: "pg" },
        } as MastraMemoryConfig,
        "mem"
      );
      expect(store).toBeTruthy();
    } finally {
      delete process.env[ENV_PASSWORD_OVERRIDE];
    }
  });

  it("fails closed with the provider-unknown code for an unsupported provider", async () => {
    const graphCode = await rejectionGraphCodeOf(() =>
      resolveMastraMemoryStorage(
        { provider: "redis" } as unknown as MastraMemoryConfig,
        "mem"
      )
    );
    expect(graphCode).toBe(GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN);
  });

  it("fails closed on generate when a wired memory declares no threadId", async () => {
    const fake = recordingAgentFactory();
    const harness = frameSinkHarness("saa-838-memory-no-thread-run");

    const result = await runDocument(
      {
        mastra: {},
        stepHandlers: createMastraDefaultStepHandlers(),
        createAgent: fake.createAgent,
      },
      memoryWiredDocument("saa-838-memory-no-thread-run", { provider: "memory" }),
      harness,
      { message: "hello" }
    );

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    // The agent step fails closed with the memory-unavailable graph code: a
    // thread-less memory binding must never fabricate conversation semantics.
    const error = failedError(harness, "agent");
    expect(error?.code).toBe(GRAPH_MASTRA_MEMORY_UNAVAILABLE);
    expect(fake.calls).toHaveLength(0);
    const types = harness.events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_FAILED);
    expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_COMPLETED);
  });
});

describe("mastra memory driver run — R8 no-driver on-demand libsql (SAA-838 M2)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("resolves a libsql memory over a local file with no external database service", async () => {
    const dbPath = join(libsqlDir, "agent-memory.db");
    const config: MastraMemoryConfig = {
      provider: "libsql",
      connection: { url: `file:${dbPath}` },
    };

    const storage = await resolveMastraMemoryStorage(config, "on-demand");
    expect(storage).toBeDefined();

    const { memory, descriptor } = await resolveMastraMemory(config);
    expect(memory).toBeInstanceOf(Memory);
    expect(descriptor).toEqual({
      type: "mastra.memory",
      provider: "libsql",
      id: "libsql",
    });

    // Touch the storage so the local file materialises, then assert no external
    // service was needed: the db lives on the local filesystem.
    await memory.saveThread({
      thread: {
        id: "on-demand-thread",
        resourceId: "on-demand-resource",
        title: "on-demand",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never);
    await memory.saveMessages({
      messages: [
        {
          id: "on-demand-message-1",
          role: "user",
          content: {
            format: 2,
            parts: [{ type: "text", text: "hello" }],
            content: "hello",
          },
          threadId: "on-demand-thread",
          resourceId: "on-demand-resource",
          createdAt: new Date(),
          type: "message",
        },
      ],
    } as never);
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe("mastra memory driver run — mastra memory semantics (SAA-838 M2)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("recalls conversation history recorded on a thread on a later read of the same thread", async () => {
    const { memory } = await resolveMastraMemory({ provider: "memory" });
    const threadId = "history-thread";
    const resourceId = "history-resource";

    await memory.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: "history",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never);
    await memory.saveMessages({
      messages: [
        {
          id: "history-message-1",
          role: "user",
          content: {
            format: 2,
            parts: [{ type: "text", text: "the launch code is morning-star" }],
            content: "the launch code is morning-star",
          },
          threadId,
          resourceId,
          createdAt: new Date(Date.now() - 1_000),
          type: "message",
        },
        {
          id: "history-message-2",
          role: "assistant",
          content: {
            format: 2,
            parts: [{ type: "text", text: "noted, I will remember that" }],
            content: "noted, I will remember that",
          },
          threadId,
          resourceId,
          createdAt: new Date(),
          type: "message",
        },
      ],
    } as never);

    const recalled = (await memory.recall({ threadId, resourceId })) as {
      messages: Array<{ role: string; content: { content?: string } }>;
    };
    expect(recalled.messages).toHaveLength(2);
    expect(recalled.messages[0].role).toBe("user");
    expect(recalled.messages[0].content.content).toContain("morning-star");
    expect(recalled.messages[1].role).toBe("assistant");
  });

  it("maps semanticRecall and the lastMessages override into the resolved memory options", async () => {
    // The named fields override the same key in the advanced passthrough.
    expect(
      mastraMemoryOptionsOf({
        provider: "memory",
        lastMessages: 4,
        semanticRecall: true,
        memoryOptions: { lastMessages: 9, generateTitle: true },
      })
    ).toEqual({ lastMessages: 4, semanticRecall: true, generateTitle: true });
    // The descriptor carries the semantic-recall configuration (R9 surface).
    expect(
      mastraMemoryDescriptorOf({
        provider: "memory",
        semanticRecall: true,
        lastMessages: 4,
      })
    ).toMatchObject({ semanticRecall: true, lastMessages: 4 });
    // A real resolved Memory applies the mapped lastMessages window.
    const { memory } = await resolveMastraMemory({ provider: "memory", lastMessages: 4 });
    expect(memory).toBeInstanceOf(Memory);
  });

  it("surfaces the working-memory template as enabled working memory and merges it into the thread config", async () => {
    const template = "Name: {{name}}\nPreferences: {{preferences}}";
    const { memory, descriptor } = await resolveMastraMemory({
      provider: "memory",
      workingMemoryTemplate: template,
    });

    // The descriptor exposes the enabled working memory (R9 surface).
    expect(descriptor.workingMemory).toEqual({ enabled: true, template });

    // The live mastra Memory carries the template and merges it into the
    // mastra thread config.
    const workingMemoryTemplate = (await memory.getWorkingMemoryTemplate(
      {} as never
    )) as { format?: string; content?: string } | null;
    expect(workingMemoryTemplate?.content).toBe(template);
    const merged = memory.getMergedThreadConfig({}) as {
      workingMemory?: { enabled?: boolean; template?: string };
    };
    expect(merged.workingMemory?.enabled).toBe(true);
    expect(merged.workingMemory?.template).toBe(template);
  });

  // A wired `workingMemoryTemplate` input overrides the configured value on
  // the mastra engine.
  it("overrides the configured working-memory template with a wired input value", async () => {
    const harness = frameSinkHarness("saa-838-memory-wired-template-run");

    const result = await runDocument(
      { mastra: {}, stepHandlers: createMastraDefaultStepHandlers() },
      document({
        id: "saa-838-memory-wired-template-run",
        name: "saa-838-memory-wired-template-run",
        nodes: [
          node("chat", "core.trigger.chat"),
          node("mem", "core.agent.memory", {
            provider: "memory",
            workingMemoryTemplate: "Configured template",
          }),
        ],
        edges: [
          edge(
            "e1",
            ["node", "chat", "message"],
            ["node", "mem", "workingMemoryTemplate"]
          ),
        ],
      }),
      harness,
      { message: "Wired template" }
    );

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    const descriptor = completedOutputs(harness, "mem")?.["resource"] as {
      workingMemory?: { template?: string };
    };
    expect(descriptor.workingMemory?.template).toBe("Wired template");
  });
});

describe("mastra memory driver run — memory selector decision (SAA-838 M2)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("emits the selected memory descriptor for a string decision", async () => {
    const harness = frameSinkHarness("saa-838-memory-selector-decision-run");

    const result = await runDocument(
      {
        mastra: {},
        stepHandlers: [
          ...createMastraDefaultStepHandlers(),
          decisionSourceStepHandler(),
        ],
      },
      document({
        id: "saa-838-memory-selector-decision-run",
        name: "saa-838-memory-selector-decision-run",
        nodes: [
          node("decision", "test.memoryDecisionSource"),
          node("selector", "core.agent.memorySelector", {
            memories: ["alpha", "beta"],
          }),
        ],
        edges: [
          edge(
            "e1",
            ["node", "decision", "decision"],
            ["node", "selector", "decision"]
          ),
        ],
      }),
      harness,
      { decision: "beta" }
    );

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    const outputs = completedOutputs(harness, "selector");
    expect(outputs?.["selected"]).toBe("beta");
    expect(outputs?.["resource"]).toEqual({ type: "mastra.memory", id: "beta" });
  });

  it("selects the first declared candidate without a decision and null with no candidates", async () => {
    const firstHarness = frameSinkHarness("saa-838-memory-selector-first-run");
    await runDocument(
      { mastra: {}, stepHandlers: createMastraDefaultStepHandlers() },
      document({
        id: "saa-838-memory-selector-first-run",
        name: "saa-838-memory-selector-first-run",
        nodes: [
          node("selector", "core.agent.memorySelector", {
            memories: ["alpha", "beta"],
          }),
        ],
      }),
      firstHarness
    );
    const firstOutputs = completedOutputs(firstHarness, "selector");
    expect(firstOutputs?.["selected"]).toBe("alpha");
    expect(firstOutputs?.["resource"]).toEqual({ type: "mastra.memory", id: "alpha" });

    const emptyHarness = frameSinkHarness("saa-838-memory-selector-empty-run");
    await runDocument(
      { mastra: {}, stepHandlers: createMastraDefaultStepHandlers() },
      document({
        id: "saa-838-memory-selector-empty-run",
        name: "saa-838-memory-selector-empty-run",
        nodes: [node("selector", "core.agent.memorySelector")],
      }),
      emptyHarness
    );
    const emptyOutputs = completedOutputs(emptyHarness, "selector");
    expect(emptyOutputs?.["selected"]).toBeNull();
    expect(emptyOutputs?.["resource"]).toBeNull();
  });
});
