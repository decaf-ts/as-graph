/**
 * @module as-graph/tests/integration/mastra/MastraStage4BreadthLive
 * @summary SAA-1066 live integration evidence for the Stage 4 mastra breadth:
 * PGVector, Apache AGE, the graph binding, and the libsql/pg memory matrix.
 * @description Opt-in live suites. Set `GRAPH_IT_PGVECTOR_HOST` and/or
 * `GRAPH_IT_AGE_HOST` (with the matching `_PORT`/`_DATABASE`/`_USER`/
 * `_PASSWORD` overrides) to run them; the suites report honestly as skipped
 * when no endpoint is configured. The AGE suite additionally requires the host
 * SQL session's `search_path` to include `ag_catalog` — the Apache AGE
 * prerequisite for `create_graph` — which is why this suite configures its own
 * single-connection client instead of sharing the default pool.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as PgClient } from "pg";
import { PgVector, PostgresStore } from "@mastra/pg";
import type { MastraVector } from "@mastra/core/vector";
import { Memory } from "@mastra/memory";
import { InMemoryStore } from "@mastra/core/storage";
import {
  DriverBackedVectorStore,
  resolveMastraVectorStore,
  type MastraVectorConstructor,
  type MastraVectorStoreConfig,
} from "../../../src/mastra/MastraVectorStore";
import {
  createMastraAgeVectorDriver,
  type MastraVectorSqlClient,
} from "../../../src/mastra/MastraAgeVectorDriver";
import {
  resolveMastraMemory,
  resolveMastraMemoryStorage,
} from "../../../src/mastra/MastraMemory";
import {
  GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
  GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED,
} from "../../../src/mastra/MastraEnvironment";
import {
  GRAPH_MASTRA_VECTOR_UNAVAILABLE,
  GRAPH_MASTRA_MEMORY_VECTOR_REQUIRED,
} from "../../../src/mastra/types";

jest.setTimeout(180_000);

/** Reads a trimmed environment variable, treating empty as unset. */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** Live PGVector endpoint configuration, or `undefined` when not configured. */
const PG = (() => {
  const host = env("GRAPH_IT_PGVECTOR_HOST");
  if (!host) return undefined;
  return {
    host,
    port: Number(env("GRAPH_IT_PGVECTOR_PORT") ?? "55441"),
    database: env("GRAPH_IT_PGVECTOR_DATABASE") ?? "test",
    user: env("GRAPH_IT_PGVECTOR_USER") ?? "postgres",
    password: env("GRAPH_IT_PGVECTOR_PASSWORD") ?? "postgres",
  };
})();

/** Live Apache AGE endpoint configuration, or `undefined` when not configured. */
const AGE = (() => {
  const host = env("GRAPH_IT_AGE_HOST");
  if (!host) return undefined;
  return {
    host,
    port: Number(env("GRAPH_IT_AGE_PORT") ?? "55442"),
    database: env("GRAPH_IT_AGE_DATABASE") ?? "test",
    user: env("GRAPH_IT_AGE_USER") ?? "postgres",
    password: env("GRAPH_IT_AGE_PASSWORD") ?? "postgres",
  };
})();

const livePg = PG ? describe : describe.skip;
const liveAge = AGE ? describe : describe.skip;

/** A unique SQL identifier fragment for this process. */
const STAMP = `${Date.now()}_${process.pid}`;

/** The credential environment variable the pgvector suite injects. */
const PGVECTOR_CREDENTIAL = "MASTRA_IT_PGVECTOR_PASSWORD";

/** The credential environment variable the pg-meory suite injects. */
const PG_MEMORY_CREDENTIAL = "MASTRA_IT_PG_MEMORY_PASSWORD";

/** The graph fixture name for the graph-binding row. */
const GRAPH_NAME = `as_graph_age_gi_${STAMP}`;

livePg("PGVector live (SAA-1066)", () => {
  const indexName = `saa1066_pgv_${STAMP}`;
  let resolved: ReturnType<typeof resolveMastraVectorStore>;

  beforeAll(() => {
    process.env[PGVECTOR_CREDENTIAL] = PG!.password;
    const config: MastraVectorStoreConfig = {
      provider: "pgvector",
      id: indexName,
      indexName,
      dimension: 3,
      metric: "cosine",
      embedding: {
        provider: "openai",
        modelId: "text-embedding-3-small",
        dimension: 3,
      },
      connection: {
        host: PG!.host,
        port: PG!.port,
        database: PG!.database,
        user: PG!.user,
        schemaName: "public",
      },
      credentialRef: { credentialId: PGVECTOR_CREDENTIAL, credentialType: "password" },
    };
    resolved = resolveMastraVectorStore(config, {
      bindings: { pgvector: PgVector as unknown as MastraVectorConstructor },
    });
  });

  afterAll(async () => {
    try {
      await resolved.store.deleteIndex({ indexName });
    } catch {
      // The index may already be gone after the delete test.
    }
    await (resolved.store as unknown as { disconnect?: () => Promise<void> })
      .disconnect?.();
    delete process.env[PGVECTOR_CREDENTIAL];
  });

  it("resolves a real PgVector store and a secret-free descriptor with the embedding config", () => {
    expect(resolved.store).toBeInstanceOf(PgVector);
    expect(resolved.descriptor).toMatchObject({
      type: "mastra.vectorStore",
      provider: "pgvector",
      id: indexName,
      embedding: {
        provider: "openai",
        modelId: "text-embedding-3-small",
        dimension: 3,
      },
    } as never);
    expect(JSON.stringify(resolved.descriptor)).not.toContain(PG!.password);
  });

  it("creates the index with the configured dimensions and round-trips a filtered query", async () => {
    await resolved.store.createIndex({
      indexName,
      dimension: 3,
      metric: "cosine",
    });
    const stats = await resolved.store.describeIndex({ indexName });
    expect(stats.dimension).toBe(3);
    expect(stats.metric).toBe("cosine");

    const ids = await resolved.store.upsert({
      indexName,
      vectors: [
        [1, 0, 0],
        [0, 1, 0],
        [0.9, 0.1, 0],
      ],
      metadata: [
        { category: "alpha" },
        { category: "beta" },
        { category: "alpha" },
      ],
      ids: [`${indexName}-a`, `${indexName}-b`, `${indexName}-c`],
    });
    expect(ids).toEqual([
      `${indexName}-a`,
      `${indexName}-b`,
      `${indexName}-c`,
    ]);

    const filtered = await resolved.store.query({
      indexName,
      queryVector: [1, 0, 0],
      topK: 5,
      filter: { category: { $eq: "alpha" } },
    });
    expect(filtered.map((hit) => hit.id)).toEqual([
      `${indexName}-a`,
      `${indexName}-c`,
    ]);
    expect(
      (await resolved.store.describeIndex({ indexName })).count
    ).toBe(3);
  });

  it("updates and deletes vectors and removes the index", async () => {
    await resolved.store.updateVector({
      indexName,
      id: `${indexName}-b`,
      update: { metadata: { category: "alpha" } },
    });
    const afterUpdate = await resolved.store.query({
      indexName,
      queryVector: [1, 0, 0],
      topK: 5,
      filter: { category: { $eq: "alpha" } },
    });
    expect(afterUpdate.map((hit) => hit.id)).toContain(`${indexName}-b`);

    await resolved.store.deleteVectors({
      indexName,
      filter: { category: { $eq: "alpha" } },
    });
    expect(
      (await resolved.store.describeIndex({ indexName })).count
    ).toBe(0);

    await resolved.store.deleteIndex({ indexName });
    await expect(
      resolved.store.describeIndex({ indexName })
    ).rejects.toBeDefined();
  });

  it("fails the credential gate before opening a connection", () => {
    expect(() =>
      resolveMastraVectorStore(
        {
          provider: "pgvector",
          id: "no-credential",
          connection: {
            host: PG!.host,
            port: PG!.port,
            database: PG!.database,
            user: PG!.user,
          },
        },
        { bindings: { pgvector: PgVector as unknown as MastraVectorConstructor } }
      )
    ).toThrow(
      expect.objectContaining({ graphCode: GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE })
    );
    expect(() =>
      resolveMastraVectorStore(
        {
          provider: "pgvector",
          id: "plaintext",
          connection: {
            host: PG!.host,
            port: PG!.port,
            database: PG!.database,
            user: PG!.user,
            password: "plaintext",
          },
          credentialRef: {
            credentialId: PGVECTOR_CREDENTIAL,
            credentialType: "password",
          },
        },
        { bindings: { pgvector: PgVector as unknown as MastraVectorConstructor } }
      )
    ).toThrow(
      expect.objectContaining({ graphCode: GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED })
    );
  });
});

liveAge("Apache AGE live (SAA-1066)", () => {
  let client: PgClient;
  let sql: MastraVectorSqlClient;
  const graphName = `saa1066_age_${STAMP}`;
  const indexName = `saa1066_age_idx_${STAMP}`;
  let store: MastraVector;

  beforeAll(async () => {
    client = new PgClient({
      host: AGE!.host,
      port: AGE!.port,
      database: AGE!.database,
      user: AGE!.user,
      password: AGE!.password,
    });
    await client.connect();
    await client.query(
      'SET search_path = ag_catalog, "$user", public'
    );
    sql = {
      query: async (text: string, params?: readonly unknown[]) => {
        const result = await client.query(
          text,
          params as unknown[] | undefined
        );
        return { rows: result.rows as Record<string, unknown>[] };
      },
    };
    const driver = createMastraAgeVectorDriver({
      client: sql,
      graphName,
      tablePrefix: `vectors_${STAMP}`,
    });
    store = resolveMastraVectorStore(
      {
        provider: "age",
        id: indexName,
        indexName,
        dimension: 3,
        metric: "cosine",
      },
      { drivers: { age: driver } }
    ).store;
  });

  afterAll(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${graphName}" CASCADE`);
      await client.query(
        "SELECT ag_catalog.drop_graph($1::name, true)",
        [graphName]
      );
    } catch {
      // Best-effort cleanup; the container is torn down by the issue owner.
    }
    await client.end();
  });

  it("creates the AGE graph and schema idempotently across driver instances", async () => {
    await store.createIndex({ indexName, dimension: 3, metric: "cosine" });
    expect(await store.listIndexes()).toContain(indexName);

    // A second driver over the same graph must reuse the graph/tables.
    const driver = createMastraAgeVectorDriver({
      client: sql,
      graphName,
      tablePrefix: `vectors_${STAMP}`,
    });
    const again = resolveMastraVectorStore(
      { provider: "age", id: indexName, indexName },
      { drivers: { age: driver } }
    ).store;
    await again.createIndex({ indexName, dimension: 3, metric: "cosine" });
    const stats = await again.describeIndex({ indexName });
    expect(stats.dimension).toBe(3);
    expect(stats.count).toBe(0);

    const graphs = await client.query(
      "SELECT name FROM ag_catalog.ag_graph WHERE name = $1",
      [graphName]
    );
    expect(graphs.rows).toHaveLength(1);
  });

  it("writes vectors, queries by vector with a metadata filter, updates and deletes", async () => {
    const ids = await store.upsert({
      indexName,
      vectors: [
        [1, 0, 0],
        [0, 1, 0],
        [0.8, 0.2, 0],
      ],
      metadata: [
        { topic: "alpha" },
        { topic: "beta" },
        { topic: "alpha" },
      ],
    });
    expect(ids).toHaveLength(3);

    const hits = await store.query({
      indexName,
      queryVector: [1, 0, 0],
      topK: 2,
      filter: { topic: { $eq: "alpha" } },
      includeVector: true,
    });
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.metadata?.["topic"] === "alpha")).toBe(true);
    expect(hits[0].vector).toHaveLength(3);

    await store.updateVector({
      indexName,
      id: ids[1],
      update: { vector: [1, 0, 0], metadata: { topic: "alpha" } },
    });
    const afterUpdate = await store.query({
      indexName,
      queryVector: [1, 0, 0],
      topK: 5,
      filter: { topic: { $eq: "alpha" } },
    });
    expect(afterUpdate.map((hit) => hit.id)).toContain(ids[1]);

    await store.deleteVector({ indexName, id: ids[1] });
    await store.deleteVectors({
      indexName,
      filter: { topic: { $eq: "alpha" } },
    });
    expect((await store.describeIndex({ indexName })).count).toBe(0);
  });

  it("binds the same live driver through the custom graph provider", async () => {
    const driver = createMastraAgeVectorDriver({
      client: sql,
      graphName,
      tablePrefix: `vectors_${STAMP}`,
    });
    const graphStore = resolveMastraVectorStore(
      { provider: "graph", id: GRAPH_NAME, indexName },
      { drivers: { graph: driver } }
    ).store;
    expect(graphStore).toBeInstanceOf(DriverBackedVectorStore);
    await graphStore.upsert({
      indexName,
      vectors: [[0, 1, 0]],
      metadata: [{ topic: "beta" }],
      ids: [`${GRAPH_NAME}-1`],
    });
    const hits = await graphStore.query({
      indexName,
      queryVector: [0, 1, 0],
      topK: 1,
    });
    expect(hits[0].id).toBe(`${GRAPH_NAME}-1`);
    await graphStore.deleteVector({ indexName, id: `${GRAPH_NAME}-1` });
  });

  it("fails closed without a host driver", () => {
    expect(() =>
      resolveMastraVectorStore({ provider: "age", id: "no-driver" })
    ).toThrow(
      expect.objectContaining({ graphCode: GRAPH_MASTRA_VECTOR_UNAVAILABLE })
    );
  });
});

describe("memory matrix live (SAA-1066)", () => {
  const libsqlDir = mkdtempSync(join(tmpdir(), "saa1066-libsql-"));
  const libsqlUrl = `file:${join(libsqlDir, "memory.db")}`;
  const threadId = `thread-${STAMP}`;
  const resourceId = `resource-${STAMP}`;

  afterAll(() => {
    rmSync(libsqlDir, { recursive: true, force: true });
  });

  it("round-trips threads and messages over the memory baseline", async () => {
    const { memory } = await resolveMastraMemory({ provider: "memory" });
    await memory.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: "baseline",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never);
    await memory.saveMessages({
      messages: [
        {
          id: `${threadId}-m1`,
          role: "user",
          content: {
            format: 2,
            parts: [{ type: "text", text: "baseline hello" }],
            content: "baseline hello",
          },
          threadId,
          resourceId,
          createdAt: new Date(),
          type: "message",
        },
      ],
    } as never);
    const recalled = await memory.recall({ threadId, resourceId });
    expect(recalled.messages).toHaveLength(1);
    expect(await memory.getThreadById({ threadId, resourceId })).toMatchObject({
      id: threadId,
    });
  });

  it("round-trips threads and messages over live libsql", async () => {
    const config = {
      provider: "libsql" as const,
      id: `libsql-${STAMP}`,
      connection: { url: libsqlUrl },
    };
    const storage = await resolveMastraMemoryStorage(config, config.id);
    const { memory, descriptor } = await resolveMastraMemory(config, {
      storage,
    });
    expect(memory).toBeInstanceOf(Memory);
    expect(descriptor).toMatchObject({ provider: "libsql" });

    await memory.saveThread({
      thread: {
        id: `${threadId}-libsql`,
        resourceId,
        title: "libsql",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never);
    await memory.saveMessages({
      messages: [
        {
          id: `${threadId}-libsql-m1`,
          role: "user",
          content: {
            format: 2,
            parts: [{ type: "text", text: "libsql hello" }],
            content: "libsql hello",
          },
          threadId: `${threadId}-libsql`,
          resourceId,
          createdAt: new Date(),
          type: "message",
        },
      ],
    } as never);
    const recalled = await memory.recall({
      threadId: `${threadId}-libsql`,
      resourceId,
    });
    expect(recalled.messages).toHaveLength(1);

    // A fresh memory over the same store proves the messages persisted.
    const reopened = await resolveMastraMemory(config, { storage });
    const persisted = await reopened.memory.recall({
      threadId: `${threadId}-libsql`,
      resourceId,
    });
    expect(persisted.messages).toHaveLength(1);
    await storage.close();
  });

  livePg("round-trips threads and messages over live Postgres memory", () => {
    it("resolves and persists through @mastra/pg PostgresStore", async () => {
      process.env[PG_MEMORY_CREDENTIAL] = PG!.password;
      const schemaName = `saa1066_mem_${STAMP}`;
      const config = {
        provider: "pg" as const,
        id: `pg-${STAMP}`,
        connection: {
          host: PG!.host,
          port: PG!.port,
          database: PG!.database,
          user: PG!.user,
          schemaName,
        },
        credentialRef: {
          credentialId: PG_MEMORY_CREDENTIAL,
          credentialType: "password",
        },
      };
      const storage = await resolveMastraMemoryStorage(config, config.id);
      expect(storage).toBeInstanceOf(PostgresStore);
      const { memory, descriptor } = await resolveMastraMemory(config, {
        storage,
      });
      expect(memory).toBeInstanceOf(Memory);
      expect(descriptor).toMatchObject({ provider: "pg" });

      await memory.saveThread({
        thread: {
          id: `${threadId}-pg`,
          resourceId,
          title: "pg",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      } as never);
      await memory.saveMessages({
        messages: [
          {
            id: `${threadId}-pg-m1`,
            role: "user",
            content: {
              format: 2,
              parts: [{ type: "text", text: "pg hello" }],
              content: "pg hello",
            },
            threadId: `${threadId}-pg`,
            resourceId,
            createdAt: new Date(),
            type: "message",
          },
        ],
      } as never);
      const recalled = await memory.recall({
        threadId: `${threadId}-pg`,
        resourceId,
      });
      expect(recalled.messages).toHaveLength(1);

      // A fresh memory over the same store proves the messages persisted.
      const reopened = await resolveMastraMemory(config, { storage });
      const persisted = await reopened.memory.recall({
        threadId: `${threadId}-pg`,
        resourceId,
      });
      expect(persisted.messages).toHaveLength(1);

      await storage.close();
      delete process.env[PG_MEMORY_CREDENTIAL];
    });
  });

  it("rejects semantic recall without a host vector store through the graph fail-closed code", async () => {
    // SAA-1077 D1: the resolver now owns the semantic-recall seam and fails
    // closed with its own graph code instead of surfacing mastra's raw error.
    let error: unknown;
    try {
      await resolveMastraMemory({
        provider: "libsql",
        id: `semantic-${STAMP}`,
        connection: { url: libsqlUrl },
        semanticRecall: true,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      graphCode: GRAPH_MASTRA_MEMORY_VECTOR_REQUIRED,
    });
    expect(String((error as Error).message)).toMatch(/vector store/i);
  });

  it("keeps the memory provider baseline free of external services", async () => {
    const storage = await resolveMastraMemoryStorage(
      { provider: "memory" },
      "baseline"
    );
    expect(storage).toBeInstanceOf(InMemoryStore);
    await storage.close();
  });
});
