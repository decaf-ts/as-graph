/**
 * @module as-graph/tests/unit/graph/mastra/MastraVectorStoreMatrix
 * @summary SAA-1066 unit evidence: the Stage 4 vector-store provider matrix.
 * @description Pins the descriptor/config contract for every provider in
 * `MASTRA_VECTOR_PROVIDERS`: each provider resolves a descriptor (memory
 * natively, age/graph through a host driver, every mastra-native provider
 * through a host-bound constructor), an unknown provider is rejected, the
 * embedding and credentialKey members are validated, and the capabilities rows
 * are exposed. No optional backend package is imported and no network is used.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  DriverBackedVectorStore,
  InMemoryVectorStore,
  MASTRA_NATIVE_VECTOR_BINDING_HINTS,
  MASTRA_NATIVE_VECTOR_PROVIDERS,
  MASTRA_VECTOR_DEFAULT_CREDENTIAL_KEYS,
  MASTRA_VECTOR_PROVIDERS,
  isMastraNativeVectorProvider,
  isMastraVectorStoreConfig,
  mastraVectorMatchesFilter,
  mastraVectorScore,
  mastraVectorStoreConfigOf,
  mastraVectorStoreDescriptorOf,
  resolveMastraVectorStore,
  type MastraVectorConstructor,
  type MastraVectorDriver,
  type MastraVectorProvider,
  type MastraVectorStoreBindings,
  type MastraVectorStoreConfig,
} from "../../../../src/mastra/MastraVectorStore";
import {
  GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
  GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED,
} from "../../../../src/mastra/MastraEnvironment";
import {
  GRAPH_MASTRA_VECTOR_PROVIDER_UNKNOWN,
  GRAPH_MASTRA_VECTOR_UNAVAILABLE,
} from "../../../../src/mastra/types";
import {
  MASTRA_FEATURE_CAPABILITIES,
  mastraCapabilityOf,
} from "../../../../src/mastra/MastraCapabilities";
import { node } from "../../../../src/workflows/builders";

/** The test-only environment variable carrying a resolved credential value. */
const ENV_SECRET = "MASTRA_TEST_VECTOR_MATRIX_PASSWORD";

/** A recording host-bound constructor that captures its options. */
class RecordingBinding {
  readonly options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
}

const recordingBinding = RecordingBinding as unknown as MastraVectorConstructor;

/** A no-op driver; resolution only constructs the store, it never calls it. */
const driver: MastraVectorDriver = {
  query: async () => [],
  upsert: async () => [],
  createIndex: async () => {},
  listIndexes: async () => [],
  describeIndex: async () => ({ dimension: 0, count: 0 }),
  deleteIndex: async () => {},
  updateVector: async () => {},
  deleteVector: async () => {},
  deleteVectors: async () => {},
};

/** Restores the test credential environment variable after every test. */
afterEach(() => {
  delete process.env[ENV_SECRET];
});

/** Builds the host bindings that resolve every mastra-native provider. */
function allBindings(): MastraVectorStoreBindings {
  const bindings: MastraVectorStoreBindings = {};
  for (const provider of MASTRA_NATIVE_VECTOR_PROVIDERS) {
    bindings[provider] = recordingBinding;
  }
  return bindings;
}

/** A minimal valid credential reference for a provider. */
function credentialRef(provider: string) {
  return { credentialId: ENV_SECRET, credentialType: provider };
}

/** Returns the graph code of a thrown error, or `undefined` when it resolved. */
function graphCodeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { graphCode?: string }).graphCode;
  }
}

describe("mastra vector-store provider matrix (SAA-1066)", () => {
  it("declares every expected provider and keeps the native subset exact", () => {
    expect([...MASTRA_VECTOR_PROVIDERS]).toEqual([
      "memory",
      "pgvector",
      "redis",
      "upstash",
      "age",
      "graph",
      "qdrant",
      "pinecone",
      "supabase",
      "mongodb",
      "libsql",
      "chroma",
    ]);
    expect([...MASTRA_NATIVE_VECTOR_PROVIDERS]).toEqual([
      "pgvector",
      "redis",
      "upstash",
      "qdrant",
      "pinecone",
      "supabase",
      "mongodb",
      "libsql",
      "chroma",
    ]);
    for (const provider of MASTRA_VECTOR_PROVIDERS) {
      const native = (MASTRA_NATIVE_VECTOR_PROVIDERS as readonly string[]).includes(
        provider
      );
      expect(isMastraNativeVectorProvider(provider)).toBe(native);
    }
    expect(isMastraNativeVectorProvider("memory")).toBe(false);
    expect(isMastraNativeVectorProvider("age")).toBe(false);
    expect(isMastraNativeVectorProvider("graph")).toBe(false);
    expect(isMastraNativeVectorProvider("bogus")).toBe(false);
  });

  it("documents a binding hint and a default credential key for every native provider", () => {
    for (const provider of MASTRA_NATIVE_VECTOR_PROVIDERS) {
      expect(MASTRA_NATIVE_VECTOR_BINDING_HINTS[provider]).toEqual(
        expect.any(String)
      );
      expect(MASTRA_NATIVE_VECTOR_BINDING_HINTS[provider].length).toBeGreaterThan(
        0
      );
      expect(MASTRA_VECTOR_DEFAULT_CREDENTIAL_KEYS[provider]).toEqual(
        expect.any(String)
      );
    }
  });

  it("resolves a store and descriptor for every provider", () => {
    process.env[ENV_SECRET] = "matrix-secret";
    for (const provider of MASTRA_VECTOR_PROVIDERS) {
      const config: MastraVectorStoreConfig = {
        provider,
        id: `vs-${provider}`,
        ...(provider === "pgvector" ? { credentialRef: credentialRef(provider) } : {}),
      };
      const { store, descriptor } = resolveMastraVectorStore(config, {
        bindings: allBindings(),
        drivers: { age: driver, graph: driver },
      });

      expect(descriptor).toEqual({
        type: "mastra.vectorStore",
        provider,
        id: `vs-${provider}`,
        ...(provider === "pgvector"
          ? { credentialRef: credentialRef(provider) }
          : {}),
      });
      expect(descriptor.provider).toBe(provider as MastraVectorProvider);
      if (provider === "memory") {
        expect(store).toBeInstanceOf(InMemoryVectorStore);
      } else if (provider === "age" || provider === "graph") {
        expect(store).toBeInstanceOf(DriverBackedVectorStore);
      } else {
        expect(store).toBeInstanceOf(RecordingBinding);
      }
      // The descriptor stays JSON-safe and secret-free.
      expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    }
  });

  it("rejects an unknown provider instead of fabricating a store", () => {
    const config = { provider: "not-a-store", id: "x" } as unknown as MastraVectorStoreConfig;
    expect(isMastraVectorStoreConfig(config)).toBe(false);
    expect(
      graphCodeOf(() =>
        resolveMastraVectorStore(config, { bindings: allBindings() })
      )
    ).toBe(GRAPH_MASTRA_VECTOR_PROVIDER_UNKNOWN);
  });

  it("fails closed for age/graph without a host driver and for a native provider without a binding", () => {
    for (const provider of ["age", "graph"] as const) {
      expect(
        graphCodeOf(() =>
          resolveMastraVectorStore({ provider, id: `vs-${provider}` }, {})
        )
      ).toBe(GRAPH_MASTRA_VECTOR_UNAVAILABLE);
    }
    for (const provider of MASTRA_NATIVE_VECTOR_PROVIDERS) {
      expect(
        graphCodeOf(() =>
          resolveMastraVectorStore(
            {
              provider,
              id: `vs-${provider}`,
              ...(provider === "pgvector"
                ? { credentialRef: credentialRef(provider) }
                : {}),
            },
            {}
          )
        )
      ).toBe(GRAPH_MASTRA_VECTOR_UNAVAILABLE);
    }
  });

  it("validates embedding and credentialKey members and keeps them out of the secret path", () => {
    expect(
      isMastraVectorStoreConfig({
        provider: "qdrant",
        embedding: { provider: "openai", modelId: "text-embedding-3-small" },
      })
    ).toBe(true);
    for (const embedding of [
      {},
      { provider: "openai" },
      { modelId: "text-embedding-3-small" },
      { provider: "", modelId: "m" },
      { provider: "openai", modelId: "" },
    ]) {
      expect(
        isMastraVectorStoreConfig({ provider: "qdrant", embedding })
      ).toBe(false);
    }
    expect(
      isMastraVectorStoreConfig({ provider: "qdrant", credentialKey: 42 })
    ).toBe(false);
    expect(
      isMastraVectorStoreConfig({ provider: "qdrant", credentialKey: "apiKey" })
    ).toBe(true);

    const descriptor = mastraVectorStoreDescriptorOf({
      provider: "qdrant",
      id: "vs",
      embedding: {
        provider: "openai",
        modelId: "text-embedding-3-small",
        dimension: 1536,
      },
      credentialRef: credentialRef("qdrant"),
    });
    expect(descriptor.embedding).toEqual({
      provider: "openai",
      modelId: "text-embedding-3-small",
      dimension: 1536,
    });
    expect(descriptor.credentialRef).toEqual(credentialRef("qdrant"));
    expect(descriptor).not.toHaveProperty("connection");
    expect(descriptor).not.toHaveProperty("credentialKey");
  });

  it("injects the resolved credential under the default or configured connection key only", () => {
    process.env[ENV_SECRET] = "vector-secret";

    const defaultKey = resolveMastraVectorStore(
      {
        provider: "qdrant",
        id: "vs-default",
        connection: { url: "http://localhost:6333" },
        credentialRef: credentialRef("qdrant"),
      },
      { bindings: { qdrant: recordingBinding } }
    );
    expect((defaultKey.store as unknown as RecordingBinding).options).toEqual({
      url: "http://localhost:6333",
      id: "vs-default",
      apiKey: "vector-secret",
    });

    const customKey = resolveMastraVectorStore(
      {
        provider: "qdrant",
        id: "vs-custom",
        credentialKey: "customToken",
        credentialRef: credentialRef("qdrant"),
      },
      { bindings: { qdrant: recordingBinding } }
    );
    expect((customKey.store as unknown as RecordingBinding).options).toEqual({
      id: "vs-custom",
      customToken: "vector-secret",
    });
    expect(
      JSON.stringify((customKey.store as unknown as RecordingBinding).options)
    ).not.toContain("apiKey");
  });

  it("refuses plaintext credentials, non-MASTRA credential names, and an absent pgvector credential", () => {
    expect(
      graphCodeOf(() =>
        resolveMastraVectorStore(
          {
            provider: "qdrant",
            id: "vs",
            connection: { apiKey: "plaintext" },
            credentialRef: credentialRef("qdrant"),
          },
          { bindings: { qdrant: recordingBinding } }
        )
      )
    ).toBe(GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED);

    expect(
      graphCodeOf(() =>
        resolveMastraVectorStore(
          {
            provider: "qdrant",
            id: "vs",
            credentialRef: {
              credentialId: "LANGFUSE_SECRET_KEY",
              credentialType: "qdrant",
            },
          },
          { bindings: { qdrant: recordingBinding } }
        )
      )
    ).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);

    expect(
      graphCodeOf(() =>
        resolveMastraVectorStore(
          { provider: "pgvector", id: "vs" },
          { bindings: { pgvector: recordingBinding } }
        )
      )
    ).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);
  });

  it("reads the canonical vectorStore parameter, then the flat node shape", () => {
    const canonical = mastraVectorStoreConfigOf(
      node("v", "core.agent.vectorStore", {
        vectorStore: {
          provider: "chroma",
          embedding: { provider: "openai", modelId: "m" },
        },
        provider: "memory",
      })
    );
    expect(canonical?.provider).toBe("chroma");
    expect(canonical?.embedding).toEqual({ provider: "openai", modelId: "m" });

    const flat = mastraVectorStoreConfigOf(
      node("v", "core.agent.vectorStore", { provider: "libsql" })
    );
    expect(flat?.provider).toBe("libsql");

    expect(
      mastraVectorStoreConfigOf(
        node("v", "core.agent.vectorStore", {
          vectorStore: { provider: "not-a-store" },
        })
      )
    ).toBeUndefined();
  });

  it("exposes the Stage 4 capabilities rows", () => {
    expect(MASTRA_FEATURE_CAPABILITIES.map((row) => row.feature)).toEqual(
      expect.arrayContaining(["vectorStores", "memoryStorage", "processorVariants"])
    );
    expect(mastraCapabilityOf("vectorStores")?.verdict).toBe("SUPPORTED");
    expect(mastraCapabilityOf("memoryStorage")?.verdict).toBe("SUPPORTED");
    expect(mastraCapabilityOf("processorVariants")?.verdict).toBe("SUPPORTED");
  });

  it("keeps the shared filter and score helpers honest", () => {
    expect(
      mastraVectorMatchesFilter(
        { kind: "a", score: 3 },
        { kind: "a", score: { $gte: 2 } }
      )
    ).toBe(true);
    expect(
      mastraVectorMatchesFilter({ kind: "a" }, { kind: { $in: ["b"] } })
    ).toBe(false);
    expect(
      mastraVectorMatchesFilter({ kind: "a" }, { kind: { $unknown: 1 } })
    ).toBe(false);
    expect(mastraVectorScore("cosine", [1, 0], [1, 0])).toBeCloseTo(1);
    expect(mastraVectorScore("euclidean", [0, 0], [3, 4])).toBeCloseTo(-5);
    expect(mastraVectorScore("dotproduct", [1, 2], [3, 4])).toBe(11);
  });
});
