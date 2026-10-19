/**
 * @module as-graph/tests/unit/graph/mastra/MastraHostInjectedStores
 * @summary SAA-1066 unit evidence: host-injected native vector/memory stores.
 * @description The optional `@mastra/*` backend packages are not installed in
 * this workspace, so the host-injected path is the supported integration
 * surface. These tests prove, for every mastra-native provider, that the
 * configured binding constructor is the one invoked, that it receives the
 * config's connection options plus the credential injected under the default
 * or configured key, and that an absent binding fails closed. Nothing here
 * opens a network connection.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  MASTRA_NATIVE_VECTOR_PROVIDERS,
  MASTRA_VECTOR_DEFAULT_CREDENTIAL_KEYS,
  resolveMastraVectorStore,
  type MastraVectorConstructor,
} from "../../../../src/mastra/MastraVectorStore";
import {
  MASTRA_MEMORY_DEFAULT_CREDENTIAL_KEYS,
  MASTRA_NATIVE_MEMORY_PROVIDERS,
  resolveMastraMemoryStorage,
  type MastraMemoryStorageConstructor,
} from "../../../../src/mastra/MastraMemory";
import {
  GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
} from "../../../../src/mastra/MastraEnvironment";
import {
  GRAPH_MASTRA_MEMORY_UNAVAILABLE,
  GRAPH_MASTRA_VECTOR_UNAVAILABLE,
} from "../../../../src/mastra/types";

/** The environment variable used for every injected credential. */
const ENV_SECRET = "MASTRA_TEST_HOST_INJECTED_TOKEN";

/** The connection members every provider receives in this suite. */
const CONNECTION = { endpoint: "http://127.0.0.1:1", region: "test" };

/** A recording vector binding that records the provider it was built for. */
interface RecordedVector {
  provider: string;
  options: Record<string, unknown>;
}

const vectorCalls: RecordedVector[] = [];

/**
 * Builds a distinct recording constructor per provider so a test can prove the
 * binding map routed to the right entry (not just any constructor).
 */
function vectorBinding(provider: string): MastraVectorConstructor {
  return class {
    constructor(options: Record<string, unknown>) {
      vectorCalls.push({ provider, options });
    }
  } as unknown as MastraVectorConstructor;
}

/** A recording memory-storage binding that records the provider it was built for. */
interface RecordedMemory {
  provider: string;
  options: Record<string, unknown>;
}

const memoryCalls: RecordedMemory[] = [];

/** Builds a distinct recording storage constructor per provider. */
function memoryBinding(provider: string): MastraMemoryStorageConstructor {
  return class {
    constructor(options: Record<string, unknown>) {
      memoryCalls.push({ provider, options });
    }
  } as unknown as MastraMemoryStorageConstructor;
}

/** Restores the credential environment variable after every test. */
afterEach(() => {
  delete process.env[ENV_SECRET];
  vectorCalls.length = 0;
  memoryCalls.length = 0;
});

/** Returns the graph code of a thrown/rejected error, or `undefined`. */
async function rejectionGraphCodeOf(
  fn: () => unknown | Promise<unknown>
): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as { graphCode?: string }).graphCode;
  }
}

describe("host-injected native vector stores (SAA-1066)", () => {
  it("invokes the provider-specific binding with connection options and the default credential key", () => {
    process.env[ENV_SECRET] = "injected-vector-secret";
    for (const provider of MASTRA_NATIVE_VECTOR_PROVIDERS) {
      const callsBefore = vectorCalls.length;
      resolveMastraVectorStore(
        {
          provider,
          id: `vs-${provider}`,
          connection: CONNECTION,
          credentialRef: { credentialId: ENV_SECRET, credentialType: provider },
        },
        { bindings: { [provider]: vectorBinding(provider) } }
      );

      expect(vectorCalls).toHaveLength(callsBefore + 1);
      const call = vectorCalls[callsBefore];
      expect(call.provider).toBe(provider);
      expect(call.options).toEqual({
        ...CONNECTION,
        id: `vs-${provider}`,
        [MASTRA_VECTOR_DEFAULT_CREDENTIAL_KEYS[provider]]:
          "injected-vector-secret",
      });
    }
  });

  it("honours a configured credential key instead of the provider default", () => {
    process.env[ENV_SECRET] = "injected-vector-secret";
    resolveMastraVectorStore(
      {
        provider: "qdrant",
        id: "vs-qdrant",
        connection: CONNECTION,
        credentialKey: "apiToken",
        credentialRef: { credentialId: ENV_SECRET, credentialType: "qdrant" },
      },
      { bindings: { qdrant: vectorBinding("qdrant") } }
    );
    expect(vectorCalls[0].options).toEqual({
      ...CONNECTION,
      id: "vs-qdrant",
      apiToken: "injected-vector-secret",
    });
    expect(vectorCalls[0].options).not.toHaveProperty("apiKey");
  });

  it("fails closed when no binding is injected, and never resolves a credential first", async () => {
    for (const provider of MASTRA_NATIVE_VECTOR_PROVIDERS) {
      const config = {
        provider,
        id: `vs-${provider}`,
        connection: CONNECTION,
        credentialRef: { credentialId: ENV_SECRET, credentialType: provider },
      } as const;
      expect(
        await rejectionGraphCodeOf(() => resolveMastraVectorStore(config, {}))
      ).toBe(GRAPH_MASTRA_VECTOR_UNAVAILABLE);
      expect(vectorCalls).toHaveLength(0);
    }
  });

  it("fails closed when the injected binding exists but the credential name is not a MASTRA_ variable", async () => {
    expect(
      await rejectionGraphCodeOf(() =>
        resolveMastraVectorStore(
          {
            provider: "pinecone",
            id: "vs-pinecone",
            credentialRef: {
              credentialId: "PINECONE_API_KEY",
              credentialType: "pinecone",
            },
          },
          { bindings: { pinecone: vectorBinding("pinecone") } }
        )
      )
    ).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);
    expect(vectorCalls).toHaveLength(0);
  });
});

describe("host-injected native memory storage (SAA-1066)", () => {
  it("invokes the provider-specific binding with connection options and the default credential key", async () => {
    process.env[ENV_SECRET] = "injected-memory-secret";
    const bindings: Record<string, MastraMemoryStorageConstructor> = {};
    for (const provider of MASTRA_NATIVE_MEMORY_PROVIDERS) {
      if (provider === "libsql" || provider === "pg") continue;
      bindings[provider] = memoryBinding(provider);
    }
    for (const provider of MASTRA_NATIVE_MEMORY_PROVIDERS) {
      if (provider === "libsql" || provider === "pg") continue;
      const callsBefore = memoryCalls.length;
      const store = await resolveMastraMemoryStorage(
        {
          provider,
          id: `mem-${provider}`,
          connection: CONNECTION,
          credentialRef: { credentialId: ENV_SECRET, credentialType: provider },
        },
        `mem-${provider}`,
        { storageBindings: bindings }
      );

      expect(store).toBeInstanceOf(bindings[provider]);
      expect(memoryCalls).toHaveLength(callsBefore + 1);
      const call = memoryCalls[callsBefore];
      expect(call.provider).toBe(provider);
      expect(call.options).toEqual({
        ...CONNECTION,
        id: `mem-${provider}`,
        [MASTRA_MEMORY_DEFAULT_CREDENTIAL_KEYS[provider]]:
          "injected-memory-secret",
      });
    }
  });

  it("honours a configured credential key instead of the provider default", async () => {
    process.env[ENV_SECRET] = "injected-memory-secret";
    await resolveMastraMemoryStorage(
      {
        provider: "dynamodb",
        id: "mem-dynamodb",
        connection: CONNECTION,
        credentialKey: "awsSecret",
        credentialRef: { credentialId: ENV_SECRET, credentialType: "dynamodb" },
      },
      "mem-dynamodb",
      { storageBindings: { dynamodb: memoryBinding("dynamodb") } }
    );
    expect(memoryCalls[0].options).toEqual({
      ...CONNECTION,
      id: "mem-dynamodb",
      awsSecret: "injected-memory-secret",
    });
    expect(memoryCalls[0].options).not.toHaveProperty("secretAccessKey");
  });

  it("fails closed for every unbound non-built-in native memory provider", async () => {
    for (const provider of MASTRA_NATIVE_MEMORY_PROVIDERS) {
      if (provider === "libsql" || provider === "pg") continue;
      expect(
        await rejectionGraphCodeOf(() =>
          resolveMastraMemoryStorage(
            {
              provider,
              id: `mem-${provider}`,
              connection: CONNECTION,
              credentialRef: {
                credentialId: ENV_SECRET,
                credentialType: provider,
              },
            },
            `mem-${provider}`
          )
        )
      ).toBe(GRAPH_MASTRA_MEMORY_UNAVAILABLE);
      expect(memoryCalls).toHaveLength(0);
    }
  });
});
