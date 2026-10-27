/**
 * @module as-graph/tests/unit/graph/mastra/MastraPlainCredentialGate
 * @summary SAA-1089 regression evidence: plaintext embedding credentials and
 * libsql `authToken` are refused on the mastra surfaces that previously spread
 * them into descriptors/connection options.
 * @description Pins the SAA-749 F1/F2 repair:
 *
 * - `mastraVectorStoreDescriptorOf` scans the `embedding` block with the
 *   connection credential gate before spreading it into the descriptor, and
 *   `resolveMastraVectorStore` refuses through that descriptor build before a
 *   host binding is needed.
 * - `AgentVectorStoreNode.execute` scans `this.embedding` before emitting
 *   `resource.embedding`.
 * - `resolveMastraMemoryStorage` scans a libsql `connection` (so an `authToken`
 *   fails closed) while a credential-free libsql connection still constructs
 *   `LibSQLStore`.
 *
 * Every refusal is `GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED` and never echoes the
 * value. Only fake values (`sk-live-test`, `plaintext`) are used.
 */
import { describe, expect, it } from "@jest/globals";
import { LibSQLStore } from "@mastra/libsql";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import { GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED } from "../../../../src/mastra/MastraEnvironment";
import {
  mastraVectorStoreDescriptorOf,
  resolveMastraVectorStore,
  type MastraVectorStoreConfig,
} from "../../../../src/mastra/MastraVectorStore";
import { resolveMastraMemoryStorage } from "../../../../src/mastra/MastraMemory";
import type { MastraMemoryConfig } from "../../../../src/mastra/MastraMemory";
import { AgentVectorStoreNode } from "../../../../src/mastra/nodes";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "../nodes/node-test-utils";
import { graphCodeOf } from "./helpers";

/** The fake plaintext embedding API key used across these tests. */
const FAKE_API_KEY = "sk-live-test";

/** The fake plaintext libsql auth token used across these tests. */
const FAKE_AUTH_TOKEN = "plaintext";

/** A libsql database path that starts empty for the test process. */
const libsqlPath = `file:/tmp/saa1089-plain-credential-${process.pid}.db`;

/** The embedding block the pre-fix surfaces spread into their outputs. */
const plaintextEmbedding = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  apiKey: FAKE_API_KEY,
};

/** Returns the graph code of a thrown refusal, failing when none is thrown. */
function refusalOf(fn: () => unknown): GraphExecutionError {
  try {
    fn();
  } catch (error) {
    return error as GraphExecutionError;
  }
  throw new Error("expected the surface to refuse the plaintext credential");
}

/** Returns the graph code of a rejected call, or `undefined` when it resolves. */
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

/** Closes a resolved store, tolerating a backend that never opened a pool. */
async function closeQuietly(store: { close?: () => Promise<void> }) {
  try {
    await store.close?.();
  } catch {
    // A store constructed with fake options may not own a live connection.
  }
}

describe("mastra plaintext embedding credential gate (SAA-1089 regression)", () => {
  it("refuses an embedding apiKey when building a vector-store descriptor", () => {
    const config = {
      provider: "pgvector",
      id: "vs",
      embedding: plaintextEmbedding,
    } as unknown as MastraVectorStoreConfig;

    const refusal = refusalOf(() => mastraVectorStoreDescriptorOf(config));
    expect(refusal.graphCode).toBe(GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED);
    expect(refusal?.details).toMatchObject({
      provider: "pgvector",
      id: "vs",
      key: "apiKey",
      path: "apiKey",
    });
    expect(JSON.stringify(refusal)).not.toContain(FAKE_API_KEY);
  });

  it("refuses before requiring a host binding when resolving a vector store", () => {
    // No `bindings` are supplied: the descriptor build must refuse first, so
    // the failure is the credential refusal — not VECTOR_UNAVAILABLE.
    const config = {
      provider: "pgvector",
      id: "vs",
      embedding: plaintextEmbedding,
    } as unknown as MastraVectorStoreConfig;

    expect(graphCodeOf(() => resolveMastraVectorStore(config))).toBe(
      GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED
    );
  });

  it("refuses an embedding apiKey in AgentVectorStoreNode.execute before emitting a resource", async () => {
    let refusal: GraphExecutionError | undefined;
    try {
      await executeNode(
        AgentVectorStoreNode,
        nodeExecutionRequest({ ids: ["a"] }),
        buildNodeContext("core.agent.vectorStore", {
          parameters: {
            provider: "pgvector",
            storeId: "vs",
            embedding: plaintextEmbedding,
          },
        })
      );
    } catch (error) {
      refusal = error as GraphExecutionError;
    }
    expect(refusal).toBeInstanceOf(GraphExecutionError);
    expect(refusal?.graphCode).toBe(GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED);
    expect(refusal?.details).toMatchObject({
      provider: "pgvector",
      id: "vs",
      key: "apiKey",
      path: "apiKey",
    });
    expect(JSON.stringify(refusal)).not.toContain(FAKE_API_KEY);
  });

  it("keeps a credential-free embedding descriptor buildable", () => {
    const config = {
      provider: "pgvector",
      id: "vs",
      embedding: { provider: "openai", modelId: "text-embedding-3-small" },
    } as unknown as MastraVectorStoreConfig;

    expect(mastraVectorStoreDescriptorOf(config).embedding).toEqual({
      provider: "openai",
      modelId: "text-embedding-3-small",
    });
  });

  it("keeps a credentialRef-only embedding accepted", () => {
    const config = {
      provider: "pgvector",
      id: "vs",
      embedding: {
        provider: "openai",
        modelId: "text-embedding-3-small",
        credentialRef: {
          credentialId: "MASTRA_OPENAI_EMBEDDING_KEY",
          credentialType: "openai",
        },
      },
    } as unknown as MastraVectorStoreConfig;

    expect(mastraVectorStoreDescriptorOf(config).embedding).toMatchObject({
      provider: "openai",
      modelId: "text-embedding-3-small",
      credentialRef: {
        credentialId: "MASTRA_OPENAI_EMBEDDING_KEY",
        credentialType: "openai",
      },
    });
  });
});

describe("mastra libsql memory plaintext credential gate (SAA-1089 regression)", () => {
  it("refuses a libsql connection carrying an authToken", async () => {
    const config = {
      provider: "libsql",
      id: "mem",
      connection: { url: libsqlPath, authToken: FAKE_AUTH_TOKEN },
    } as MastraMemoryConfig;

    expect(
      await rejectionGraphCodeOf(() =>
        resolveMastraMemoryStorage(config, "mem")
      )
    ).toBe(GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED);
  });

  it("still constructs LibSQLStore for a credential-free libsql connection", async () => {
    const store = await resolveMastraMemoryStorage(
      {
        provider: "libsql",
        id: "mem",
        connection: { url: libsqlPath },
      } as MastraMemoryConfig,
      "mem"
    );
    expect(store).toBeInstanceOf(LibSQLStore);
    await closeQuietly(store as unknown as { close?: () => Promise<void> });
  });
});
