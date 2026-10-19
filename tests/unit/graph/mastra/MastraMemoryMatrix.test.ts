/**
 * @module as-graph/tests/unit/graph/mastra/MastraMemoryMatrix
 * @summary SAA-1066 unit evidence: the Stage 4 memory-storage provider matrix.
 * @description Pins the descriptor/config contract for every provider in
 * `MASTRA_MEMORY_PROVIDERS`: each provider resolves a storage backend (memory/
 * libsql/pg natively, every other native provider through a host-bound
 * constructor), an unknown provider fails closed in the resolver, the node
 * execution and the agent wiring with no silent `memory` fallback, and the
 * credential-key handling. No external service is contacted.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { InMemoryStore, type MastraCompositeStore } from "@mastra/core/storage";
import type { MastraVector } from "@mastra/core/vector";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { PostgresStore } from "@mastra/pg";
import {
  MASTRA_MEMORY_DEFAULT_CREDENTIAL_KEYS,
  MASTRA_MEMORY_PROVIDERS,
  MASTRA_NATIVE_MEMORY_BINDING_HINTS,
  MASTRA_NATIVE_MEMORY_PROVIDERS,
  connectedMastraMemoryWiringOf,
  isMastraMemoryConfig,
  isMastraNativeMemoryProvider,
  mastraMemoryConfigOf,
  mastraMemoryDescriptorOf,
  mastraMemoryOptionsOf,
  resolveMastraMemory,
  resolveMastraMemoryStorage,
  type MastraAgentMemoryWiring,
  type MastraMemoryConfig,
  type MastraMemoryEmbedder,
  type MastraMemoryStorageConstructor,
} from "../../../../src/mastra/MastraMemory";
import { createMastraAgentRuntimeFromConfig } from "../../../../src/mastra/MastraAgentStepHandler";
import {
  GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
  GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED,
} from "../../../../src/mastra/MastraEnvironment";
import {
  GRAPH_MASTRA_MEMORY_EMBEDDER_REQUIRED,
  GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN,
  GRAPH_MASTRA_MEMORY_UNAVAILABLE,
  GRAPH_MASTRA_MEMORY_VECTOR_REQUIRED,
} from "../../../../src/mastra/types";
import { AgentMemoryNode } from "../../../../src/node";
import { document, edge, node } from "../../../../src/workflows/builders";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "../nodes/node-test-utils";

/** The test-only environment variable carrying the pg credential value. */
const ENV_SECRET = "MASTRA_TEST_MEMORY_MATRIX_PASSWORD";

/** A recording host-bound storage constructor capturing its options. */
class RecordingStore {
  readonly options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
}

const recordingStore =
  RecordingStore as unknown as MastraMemoryStorageConstructor;

/** A minimal libsql database path that starts empty for the test process. */
const libsqlPath = `file:/tmp/saa1066-memory-matrix-${process.pid}.db`;

/** Restores the credential environment variable after every test. */
afterEach(() => {
  delete process.env[ENV_SECRET];
});

/** Returns the graph code of a thrown/rejected error, or `undefined`. */
async function rejectionGraphCodeOf(
  fn: () => Promise<unknown>
): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as { graphCode?: string }).graphCode;
  }
}

/** Closes a resolved store, tolerating backends that never opened a pool. */
async function closeQuietly(store: MastraCompositeStore): Promise<void> {
  try {
    await store.close();
  } catch {
    // A store constructed with fake options may not own a live connection.
  }
}

/** A minimal valid credential reference for a provider. */
function credentialRef(provider: string) {
  return { credentialId: ENV_SECRET, credentialType: provider };
}

describe("mastra memory provider matrix (SAA-1066)", () => {
  it("declares every expected provider and keeps the native subset exact", () => {
    expect([...MASTRA_MEMORY_PROVIDERS]).toEqual([
      "memory",
      "libsql",
      "pg",
      "mongodb",
      "upstash",
      "cloud",
      "d1",
      "dynamodb",
      "convex",
      "astra",
      "redis",
    ]);
    expect([...MASTRA_NATIVE_MEMORY_PROVIDERS]).toEqual([
      "libsql",
      "pg",
      "mongodb",
      "upstash",
      "cloud",
      "d1",
      "dynamodb",
      "convex",
      "astra",
      "redis",
    ]);
    for (const provider of MASTRA_MEMORY_PROVIDERS) {
      expect(isMastraNativeMemoryProvider(provider)).toBe(provider !== "memory");
    }
    expect(isMastraNativeMemoryProvider("memory")).toBe(false);
    expect(isMastraNativeMemoryProvider("bogus")).toBe(false);
    for (const provider of MASTRA_NATIVE_MEMORY_PROVIDERS) {
      expect(MASTRA_NATIVE_MEMORY_BINDING_HINTS[provider].length).toBeGreaterThan(
        0
      );
      expect(MASTRA_MEMORY_DEFAULT_CREDENTIAL_KEYS[provider].length).toBeGreaterThan(
        0
      );
    }
  });

  it("resolves a storage backend for every provider", async () => {
    process.env[ENV_SECRET] = "memory-matrix-secret";
    for (const provider of MASTRA_MEMORY_PROVIDERS) {
      const config: MastraMemoryConfig = {
        provider,
        id: `mem-${provider}`,
        ...(provider === "libsql" ? { connection: { url: libsqlPath } } : {}),
        ...(provider === "pg"
          ? {
              connection: {
                host: "localhost",
                port: 5432,
                database: "db",
                user: "u",
              },
              credentialRef: credentialRef(provider),
            }
          : {}),
        ...(!["memory", "libsql", "pg"].includes(provider)
          ? {
              connection: { region: "test" },
              credentialRef: credentialRef(provider),
            }
          : {}),
      };
      const store = await resolveMastraMemoryStorage(config, config.id!, {
        storageBindings: {
          mongodb: recordingStore,
          upstash: recordingStore,
          cloud: recordingStore,
          d1: recordingStore,
          dynamodb: recordingStore,
          convex: recordingStore,
          astra: recordingStore,
          redis: recordingStore,
        },
      });

      if (provider === "memory") expect(store).toBeInstanceOf(InMemoryStore);
      else if (provider === "libsql") expect(store).toBeInstanceOf(LibSQLStore);
      else if (provider === "pg") expect(store).toBeInstanceOf(PostgresStore);
      else expect(store).toBeInstanceOf(RecordingStore);

      await closeQuietly(store);
    }
  });

  it("injects the resolved credential under the default or configured key", async () => {
    process.env[ENV_SECRET] = "memory-secret";

    const defaultKey = await resolveMastraMemoryStorage(
      {
        provider: "mongodb",
        id: "mem-default",
        connection: { uri: "mongodb://localhost:27017" },
        credentialRef: credentialRef("mongodb"),
      } as MastraMemoryConfig,
      "mem-default",
      { storageBindings: { mongodb: recordingStore } }
    );
    expect((defaultKey as unknown as RecordingStore).options).toEqual({
      uri: "mongodb://localhost:27017",
      id: "mem-default",
      password: "memory-secret",
    });

    const customKey = await resolveMastraMemoryStorage(
      {
        provider: "mongodb",
        id: "mem-custom",
        connection: { uri: "mongodb://localhost:27017" },
        credentialKey: "customSecret",
        credentialRef: credentialRef("mongodb"),
      } as MastraMemoryConfig,
      "mem-custom",
      { storageBindings: { mongodb: recordingStore } }
    );
    expect((customKey as unknown as RecordingStore).options).toEqual({
      uri: "mongodb://localhost:27017",
      id: "mem-custom",
      customSecret: "memory-secret",
    });

    const noCredential = await resolveMastraMemoryStorage(
      {
        provider: "redis",
        id: "mem-no-credential",
        connection: { host: "localhost", port: 6379 },
      } as MastraMemoryConfig,
      "mem-no-credential",
      { storageBindings: { redis: recordingStore } }
    );
    expect((noCredential as unknown as RecordingStore).options).toEqual({
      host: "localhost",
      port: 6379,
      id: "mem-no-credential",
    });
  });

  it("fails closed for an unknown provider and for every unbound native provider", async () => {
    expect(isMastraMemoryConfig({ provider: "not-a-store" })).toBe(false);
    expect(
      await rejectionGraphCodeOf(() =>
        resolveMastraMemoryStorage(
          { provider: "not-a-store" } as unknown as MastraMemoryConfig,
          "mem"
        )
      )
    ).toBe(GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN);

    for (const provider of MASTRA_NATIVE_MEMORY_PROVIDERS) {
      // `libsql` and `pg` are built in: they construct from their connection
      // options and need no host binding.
      if (provider === "libsql" || provider === "pg") continue;
      const config: MastraMemoryConfig = {
        provider,
        connection:
          provider === "libsql"
            ? { url: libsqlPath }
            : provider === "pg"
              ? { host: "localhost", port: 5432, database: "db", user: "u" }
              : { region: "test" },
        ...(provider === "libsql" ? {} : { credentialRef: credentialRef(provider) }),
      };
      expect(
        await rejectionGraphCodeOf(() =>
          resolveMastraMemoryStorage(config, `mem-${provider}`)
        )
      ).toBe(GRAPH_MASTRA_MEMORY_UNAVAILABLE);
    }
  });

  it("refuses plaintext connection credentials and non-MASTRA credential names", async () => {
    expect(
      await rejectionGraphCodeOf(() =>
        resolveMastraMemoryStorage(
          {
            provider: "mongodb",
            connection: { uri: "mongodb://localhost", password: "plaintext" },
            credentialRef: credentialRef("mongodb"),
          } as unknown as MastraMemoryConfig,
          "mem",
          { storageBindings: { mongodb: recordingStore } }
        )
      )
    ).toBe(GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED);

    expect(
      await rejectionGraphCodeOf(() =>
        resolveMastraMemoryStorage(
          {
            provider: "mongodb",
            connection: { uri: "mongodb://localhost" },
            credentialRef: {
              credentialId: "LANGFUSE_SECRET_KEY",
              credentialType: "mongodb",
            },
          } as MastraMemoryConfig,
          "mem",
          { storageBindings: { mongodb: recordingStore } }
        )
      )
    ).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);
  });

  it("does not silently fall back to memory for an unknown provider", async () => {
    expect(
      mastraMemoryConfigOf(
        node("mem", "core.agent.memory", {
          memory: { provider: "not-a-store" },
        })
      )
    ).toBeUndefined();
    expect(
      mastraMemoryConfigOf(
        node("mem", "core.agent.memory", { provider: "not-a-store" })
      )
    ).toBeUndefined();
    expect(
      mastraMemoryConfigOf(node("mem", "core.agent.memory", {}))?.provider
    ).toBe("memory");

    expect(() =>
      executeNode(
        AgentMemoryNode,
        nodeExecutionRequest({}),
        buildNodeContext("core.agent.memory", {
          parameters: { provider: "not-a-store" },
        })
      )
    ).toThrow(
      expect.objectContaining({ graphCode: GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN })
    );

    const wired = document({
      id: "saa-1066-memory-unknown",
      nodes: [
        node("agent", "core.agent"),
        node("mem", "core.agent.memory", { provider: "not-a-store" }),
      ],
      edges: [
        edge(
          "e1",
          ["node", "mem", "memory"],
          ["node", "agent", "memory"],
          "connection"
        ),
      ],
    });
    const agentNode = wired.nodes.find((entry) => entry.kind === "core.agent")!;
    expect(() => connectedMastraMemoryWiringOf(wired, agentNode)).toThrow(
      expect.objectContaining({ graphCode: GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN })
    );
  });

  it("maps the flat memoryId onto the canonical config id and keeps descriptors secret-free", () => {
    const config = mastraMemoryConfigOf(
      node("mem", "core.agent.memory", {
        provider: "libsql",
        memoryId: "chief",
        connection: { url: "file:./secret.db" },
      })
    );
    expect(config).toEqual({
      provider: "libsql",
      memoryId: "chief",
      id: "chief",
      connection: { url: "file:./secret.db" },
    });
    const descriptor = mastraMemoryDescriptorOf(config!);
    expect(descriptor).toMatchObject({
      type: "mastra.memory",
      provider: "libsql",
      id: "chief",
    });
    expect(descriptor).not.toHaveProperty("connection");
    expect(JSON.stringify(descriptor)).not.toContain("secret.db");
  });

  it("builds the named memory options without leaking the advanced passthrough", () => {
    const options = mastraMemoryOptionsOf({
      provider: "memory",
      lastMessages: 5,
      semanticRecall: true,
      generateTitle: false,
      workingMemoryTemplate: "  ",
      memoryOptions: { topK: 3 },
    });
    expect(options).toEqual({
      topK: 3,
      lastMessages: 5,
      semanticRecall: true,
      generateTitle: false,
    });
    expect(
      mastraMemoryOptionsOf({
        provider: "memory",
        workingMemoryTemplate: "Profile: {{name}}",
      })
    ).toEqual({
      workingMemory: { enabled: true, template: "Profile: {{name}}" },
    });
  });

  it("resolves a live mastra Memory over an injected storage and forwards the host bindings", async () => {
    const storage = new InMemoryStore();
    const resolved = await resolveMastraMemory(
      {
        provider: "memory",
        threadId: "thread-1",
        resourceId: "res-1",
        lastMessages: 4,
      },
      { storage }
    );
    expect(resolved.memory).toBeInstanceOf(Memory);
    expect(resolved.descriptor).toMatchObject({
      type: "mastra.memory",
      provider: "memory",
      threadId: "thread-1",
      resourceId: "res-1",
      lastMessages: 4,
    });

    process.env[ENV_SECRET] = "memory-secret";
    const viaBinding = await resolveMastraMemory(
      {
        provider: "mongodb",
        id: "mem-via-binding",
        connection: { uri: "mongodb://localhost:27017" },
        credentialRef: credentialRef("mongodb"),
      },
      { storageBindings: { mongodb: recordingStore } }
    );
    expect(viaBinding.memory).toBeInstanceOf(Memory);
    expect(viaBinding.descriptor.id).toBe("mem-via-binding");
  });

  it("fails closed with VECTOR_REQUIRED when semantic recall has no host vector store", async () => {
    expect(
      await rejectionGraphCodeOf(() =>
        resolveMastraMemory({
          provider: "memory",
          semanticRecall: true,
        })
      )
    ).toBe(GRAPH_MASTRA_MEMORY_VECTOR_REQUIRED);
  });

  it("fails closed with EMBEDDER_REQUIRED when the vector store does not embed itself", async () => {
    const vector = { isSelfEmbedding: false } as unknown as MastraVector;
    expect(
      await rejectionGraphCodeOf(() =>
        resolveMastraMemory(
          { provider: "memory", semanticRecall: true },
          { vector }
        )
      )
    ).toBe(GRAPH_MASTRA_MEMORY_EMBEDDER_REQUIRED);
  });

  it("constructs Memory when semantic recall receives a vector store and an embedder", async () => {
    const vector = { isSelfEmbedding: false } as unknown as MastraVector;
    const resolved = await resolveMastraMemory(
      { provider: "memory", semanticRecall: true },
      {
        vector,
        embedder: {
          provider: "test",
          modelId: "test-embedder",
        } as unknown as MastraMemoryEmbedder,
      }
    );
    expect(resolved.memory).toBeInstanceOf(Memory);
  });

  it("constructs Memory for a self-embedding vector store without an embedder", async () => {
    const vector = { isSelfEmbedding: true } as unknown as MastraVector;
    const resolved = await resolveMastraMemory(
      { provider: "memory", semanticRecall: true },
      { vector }
    );
    expect(resolved.memory).toBeInstanceOf(Memory);
  });

  it("forwards the host memory vector store and embedder through the agent runtime", async () => {
    const vector = { isSelfEmbedding: false } as unknown as MastraVector;
    const embedder = {
      provider: "test",
      modelId: "test-embedder",
    } as unknown as MastraMemoryEmbedder;
    const memoryNode = node("mem", "core.agent.memory", {
      provider: "memory",
      threadId: "thread-1",
      semanticRecall: true,
    });
    const wiring: MastraAgentMemoryWiring = {
      node: memoryNode,
      config: mastraMemoryConfigOf(memoryNode)!,
    };
    let captured: readonly unknown[] | undefined;
    const runtime = createMastraAgentRuntimeFromConfig({
      memoryVectorStore: vector,
      memoryEmbedder: embedder,
      createAgent: (_adapter, _node, memories) => {
        captured = memories;
        return { generate: async () => ({ text: "ok" }) };
      },
    });

    const result = await runtime.execute(
      node("agent", "core.agent"),
      { prompt: "hello" },
      undefined,
      undefined,
      [wiring]
    );

    expect(result.response).toBe("ok");
    expect(captured?.[0]).toBeInstanceOf(Memory);
  });
});
