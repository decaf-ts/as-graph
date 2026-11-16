/**
 * @module as-graph/tests/integration/mastra/MastraRagWorkflow.test
 * @summary The RAG nodes work together through their declared ports.
 * @description A retrieval pipeline is only usable when each node's data
 * reaches the next through ports the validator knows: text into the chunker,
 * chunks into the vector store, the store and a query into the retriever.
 * This suite runs that pipeline on the real `@mastra/core` runtime (in-memory
 * vector store, deterministic host embedder) through the nine-stage gate and
 * `GraphExecutionEngine.execute`.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { Test, type TestingModule } from "@nestjs/testing";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";
import { document, edge, node, port } from "../../../src/workflows/builders";
import {
  resetGraphInjectables,
  resetGraphValueAdapter,
} from "../../unit/graph/engine-fixtures";

const OBSERVABILITY = "MASTRA__OBSERVABILITY__ENABLED";
const VOCABULARY = ["invoice", "refund", "shipping", "password", "warranty"];

/** Bag-of-words embedding over a fixed vocabulary: deterministic and real. */
function embed(text: string): number[] {
  const lower = text.toLowerCase();
  const vector = VOCABULARY.map(
    (word) => lower.split(word).length - 1
  ).map((count) => count + 0.01);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

const EMBEDDING = { provider: "test", modelId: "bag-of-words", dimension: 5 };

const ragPipeline = document({
  id: "mastra-rag-pipeline",
  inputs: [port("handbook"), port("question"), port("limit")],
  outputs: [port("chunks"), port("inserted"), port("matches")],
  nodes: [
    node("chunk", "core.agent.chunking", {
      strategy: "recursive",
      separator: "\n\n",
      chunkSize: 80,
      chunkOverlap: 0,
    }),
    node("store", "core.agent.vectorStore", {
      provider: "memory",
      indexName: "handbook",
      embedding: EMBEDDING,
    }),
    node("retrieve", "core.agent.retriever", { topK: 5 }),
  ],
  edges: [
    edge("e1", ["workflow", "handbook"], ["node", "chunk", "text"]),
    edge("e2", ["node", "chunk", "chunks"], ["node", "store", "documents"]),
    edge("e3", ["node", "store", "resource"], ["node", "retrieve", "store"]),
    edge("e4", ["workflow", "question"], ["node", "retrieve", "query"]),
    // An expose-as-port configuration field driven by the workflow.
    edge("e5", ["workflow", "limit"], ["node", "retrieve", "topK"]),
    edge("e6", ["node", "chunk", "chunks"], ["workflow", "chunks"]),
    edge("e7", ["node", "store", "inserted"], ["workflow", "inserted"]),
    edge("e8", ["node", "retrieve", "documents"], ["workflow", "matches"]),
  ],
});

const HANDBOOK = [
  "Invoice questions: every invoice is issued on the first day of the month.",
  "Refund policy: a refund is paid within ten days of the refund request.",
  "Shipping times: shipping takes three days, express shipping takes one.",
  "Password reset: a password can be reset from the sign-in page.",
].join("\n\n");

describe("Mastra engine — RAG pipeline through declared ports", () => {
  let moduleRef: TestingModule;
  let engine: GraphExecutionEngine;
  let observabilityOriginal: string | undefined;

  beforeAll(async () => {
    observabilityOriginal = process.env[OBSERVABILITY];
    process.env[OBSERVABILITY] = "false";
    resetGraphInjectables();
    resetGraphValueAdapter();
    const [{ Mastra }, { InMemoryStore }] = await Promise.all([
      import("@mastra/core/mastra"),
      import("@mastra/core/storage"),
    ]);
    const runtime = new (Mastra as unknown as new (
      options: Record<string, unknown>
    ) => unknown)({
      storage: new (InMemoryStore as unknown as new () => unknown)(),
    });
    const host = await createGraphBackendHost({
      variant: "mastra",
      mastra: {
        mastra: runtime,
        embedText: async ({ values }) => values.map(embed),
      },
      base: {
        initAdapter: true,
        runs: { auth: "optional", allowAnonymousAccess: true },
        workflows: { auth: "optional", allowAnonymousAccess: true },
        catalogue: { auth: "optional" },
        engines: { auth: "optional" },
      },
    });
    moduleRef = await Test.createTestingModule({
      imports: [GraphExecutionModule.forRoot(host.moduleOptions)],
    }).compile();
    await moduleRef.init();
    engine = moduleRef.get(GraphExecutionEngine);
  });

  afterAll(async () => {
    await moduleRef?.close();
    GraphExecutionBackendRegistry.clear();
    if (observabilityOriginal === undefined) delete process.env[OBSERVABILITY];
    else process.env[OBSERVABILITY] = observabilityOriginal;
  });

  it("chunks, indexes and retrieves the most relevant chunk", async () => {
    const result = await engine.execute(ragPipeline, {
      handbook: HANDBOOK,
      question: "How long does a refund take?",
      limit: 1,
    });
    const failed = Object.values(result.nodeResults)
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.nodeId}: ${entry.error?.message}`);
    expect(failed).toEqual([]);
    expect(result.status).toBe("succeeded");

    const chunks = result.outputs.chunks as unknown[];
    expect(chunks).toHaveLength(4);
    expect(result.outputs.inserted).toHaveLength(4);

    // `limit` was wired onto the retriever's `topK` configuration port.
    const matches = result.outputs.matches as { text: string; score: number }[];
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toMatch(/^Refund policy/);
  });
});
