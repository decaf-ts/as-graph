/**
 * @module as-graph/tests/integration/mastra/MastraRagLive
 * @summary SAA-1144 live integration coverage for the eleven mastra RAG kinds
 * that previously had unit coverage only.
 * @description Drives the real `createMastraRagStepHandlers` execution surface:
 *
 * - `embedding`, `vectorStore`, `retriever` run against the booted **PGVector**
 *   (`55441`), with a deterministic host embedder port so the suite proves the
 *   real database path without depending on an embedding SaaS credential.
 * - `chunking`, `rerank`, `structuredOutputParser` execute the real node logic
 *   (pure, deterministic).
 * - `chain.qa`, `chain.basic`, `chain.summarization`, `informationExtractor`
 *   call the live `pdm_ai` router (`DeepSeek-V4.1-Flash`) through the host
 *   `generateText` port — four real model calls in this suite.
 * - `langchainCode` runs user code through a real `node:vm` sandbox runner.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import vm from "node:vm";
import { PgVector } from "@mastra/pg";
import { describe as describeNode } from "@jest/globals";
import { createMastraRagStepHandlers } from "../../../src/mastra/MastraRagStepHandlers";
import { MastraWorkflowCompiler } from "../../../src/mastra/MastraWorkflowCompiler";
import type {
  MastraVectorConstructor,
  MastraVectorStoreConfig,
} from "../../../src/mastra/MastraVectorStore";
import { AgentChunkingNode } from "../../../src/mastra/nodes/rag/chunking/node";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { document, edge, node } from "../../../src/workflows/builders";
import { ENDPOINTS, runNode } from "../graph/nodes/real-service-support";

jest.setTimeout(180_000);

interface ExecutableStep {
  execute: (args: { inputData?: unknown }) => Promise<Record<string, unknown>>;
}

function compileSteps(
  source: GraphWorkflowDocument,
  handlers: ReturnType<typeof createMastraRagStepHandlers>
): Map<string, ExecutableStep> {
  const compiler = new MastraWorkflowCompiler({ stepHandlers: handlers });
  const { steps } = compiler.compile(source);
  return steps as unknown as Map<string, ExecutableStep>;
}

function compileStep(
  kind: string,
  parameters: Record<string, unknown>,
  handlers: ReturnType<typeof createMastraRagStepHandlers>,
  id = "target"
): ExecutableStep {
  const source = document({
    id: `saa-1144-${kind.replace(/\./g, "-")}`,
    name: `saa-1144-${kind}`,
    nodes: [node(id, kind, parameters)],
  });
  return compileSteps(source, handlers).get(id) as ExecutableStep;
}

const EMBEDDING = {
  provider: "deterministic",
  modelId: "saa1144-embed",
  dimension: 3,
};

const MODEL_ADAPTER = { provider: "pdm", modelId: "DeepSeek-V4.1-Flash" };

const PGVECTOR_ENV = "MASTRA_IT_PGVECTOR_PASSWORD";

const STAMP = `${Date.now()}_${process.pid}`;
const INDEX_NAME = `saa1144_rag_${STAMP}`;

const PG_CONFIG: MastraVectorStoreConfig = {
  provider: "pgvector",
  id: INDEX_NAME,
  indexName: INDEX_NAME,
  dimension: 3,
  metric: "cosine",
  embedding: EMBEDDING,
  connection: {
    host: ENDPOINTS.pgvector.host,
    port: ENDPOINTS.pgvector.port,
    database: ENDPOINTS.pgvector.database,
    user: ENDPOINTS.pgvector.username,
    schemaName: "public",
  },
  credentialRef: { credentialId: PGVECTOR_ENV, credentialType: "password" },
};

const STORE_PARAMETERS = {
  ...PG_CONFIG,
} as unknown as Record<string, unknown>;

function vectorFor(value: string): number[] {
  if (value.includes("alpha")) return [1, 0, 0];
  if (value.includes("beta")) return [0, 1, 0];
  return [0, 0, 1];
}

/** The live `pdm_ai` router endpoint, read from the injected environment. */
function liveModelConfig(): {
  url: string;
  key: string;
  model: string;
} | undefined {
  const key = process.env["PDM_AI_API_KEY"]?.trim();
  if (!key) return undefined;
  return {
    url: "https://router.ai.pdmfc.com/v1/chat/completions",
    key,
    model: "DeepSeek-V4.1-Flash",
  };
}

const MODEL = liveModelConfig();
const liveModel = MODEL ? describeNode : describeNode.skip;

describe("core.agent.embedding / vectorStore / retriever — live PGVector", () => {
  const storeCache = new Map<string, unknown>();

  beforeAll(() => {
    process.env[PGVECTOR_ENV] = ENDPOINTS.pgvector.password;
  });

  afterAll(async () => {
    for (const cached of storeCache.values()) {
      const store = cached as {
        deleteIndex?: (args: { indexName: string }) => Promise<void>;
        disconnect?: () => Promise<void>;
      };
      await store.deleteIndex?.({ indexName: INDEX_NAME }).catch(() => undefined);
      await store.disconnect?.().catch(() => undefined);
    }
    delete process.env[PGVECTOR_ENV];
  });

  it("embeds the embedding kind descriptor through the real step handler", async () => {
    const handlers = createMastraRagStepHandlers({
      embedText: async ({ values }) => values.map(vectorFor),
    });
    const step = compileStep(
      "core.agent.embedding",
      { modelAdapter: EMBEDDING, dimension: 3, batchSize: 2 },
      handlers
    );

    const result = await step.execute({
      inputData: { values: ["alpha", "beta"] },
    });
    expect(result["vectors"]).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(result["resource"]).toMatchObject({
      kind: "core.agent.embedding",
      type: "mastra.embedding",
      provider: "deterministic",
      modelId: "saa1144-embed",
      dimension: 3,
    });
  });

  it("inserts into real PGVector and retrieves the nearest document", async () => {
    const handlers = createMastraRagStepHandlers({
      vectorStoreBindings: {
        pgvector: PgVector as unknown as MastraVectorConstructor,
      },
      embedText: async ({ values }) => values.map(vectorFor),
      storeCache: storeCache as never,
    });

    const source = document({
      id: "saa-1144-rag-live",
      name: "saa-1144-rag-live",
      nodes: [
        node("store", "core.agent.vectorStore", STORE_PARAMETERS),
        node("retriever", "core.agent.retriever", { topK: 2 }),
      ],
      edges: [
        edge("e1", ["node", "store", "resource"], ["node", "retriever", "store"]),
      ],
    });

    const steps = compileSteps(source, handlers);
    const inserted = await (steps.get("store") as ExecutableStep).execute({
      inputData: { documents: ["alpha", "beta", "gamma"] },
    });
    expect(inserted["inserted"]).toHaveLength(3);

    const retrieved = await (
      steps.get("retriever") as ExecutableStep
    ).execute({ inputData: { query: "alpha" } });
    const documents = retrieved["documents"] as Array<{
      text?: string;
      score?: number;
    }>;
    expect(documents.length).toBeGreaterThan(0);
    expect(documents[0]?.text).toBe("alpha");

    const store = [...storeCache.values()][0] as {
      describeIndex: (args: { indexName: string }) => Promise<{ dimension?: number }>;
    };
    const description = await store.describeIndex({ indexName: INDEX_NAME });
    expect(description.dimension).toBe(3);
  });
});

describe("core.agent.chunking — live node", () => {
  it("chunks real text and reports the count", async () => {
    const result = await runNode(
      AgentChunkingNode,
      "core.agent.chunking",
      { strategy: "character", chunkSize: 10, chunkOverlap: 0 },
      { documents: ["abcdefghijklmnopqrstuvwxyz", "short"] }
    );
    expect(result.chunks).toEqual([
      "abcdefghij",
      "klmnopqrst",
      "uvwxyz",
      "short",
    ]);
    expect(result.count).toBe(4);
  });
});

describe("core.agent.rerank — live node", () => {
  it("truncates to topN and resolves the reranker descriptor", async () => {
    const requests: Array<{ documents: unknown[]; query?: string; topN?: number }> =
      [];
    const step = compileStep(
      "core.agent.rerank",
      { topN: 2, modelAdapter: EMBEDDING },
      createMastraRagStepHandlers({
        rerankDocuments: async (request) => {
          requests.push({
            documents: [...request.documents],
            query: request.query,
            topN: request.topN,
          });
          return [
            { document: { text: "alpha" }, score: 0.95 },
            { document: { text: "beta" }, score: 0.6 },
            { document: { text: "gamma" }, score: 0.2 },
          ];
        },
      })
    );
    const result = await step.execute({
      inputData: {
        query: "alpha",
        documents: [
          { text: "gamma" },
          { text: "alpha" },
          { text: "beta" },
        ],
      },
    });
    expect(requests).toEqual([
      {
        documents: [{ text: "gamma" }, { text: "alpha" }, { text: "beta" }],
        query: "alpha",
        topN: 2,
      },
    ]);
    expect(result["documents"]).toEqual([
      { text: "alpha" },
      { text: "beta" },
    ]);
    expect(result["scores"]).toEqual([0.95, 0.6]);
    expect(result["resource"]).toMatchObject({
      type: "mastra.rerank",
      provider: "deterministic",
      modelId: "saa1144-embed",
      topN: 2,
    });
  });
});

describe("core.agent.structuredOutputParser — live node", () => {
  it("parses real model-shaped JSON text", async () => {
    const step = compileStep(
      "core.agent.structuredOutputParser",
      { strict: true, structuredOutput: { type: "object" } },
      createMastraRagStepHandlers()
    );
    const result = await step.execute({
      inputData: { text: '{"name":"Ada","score":7}' },
    });
    expect(result["object"]).toEqual({ name: "Ada", score: 7 });
  });

  it("returns null for non-JSON model output instead of fabricating a value", async () => {
    const step = compileStep(
      "core.agent.structuredOutputParser",
      {},
      createMastraRagStepHandlers()
    );
    const result = await step.execute({ inputData: { text: "not json" } });
    expect(result["object"]).toBeNull();
  });
});

describe("core.agent.langchainCode — real node:vm sandbox", () => {
  it("executes user code against the wired input", async () => {
    const handlers = createMastraRagStepHandlers({
      runSandboxedCode: async ({ code, input, timeoutMs }) => {
        const context = vm.createContext({ input, console });
        const script = new vm.Script(
          `(function (input) {\n${code}\n})(input)`
        );
        return script.runInContext(context, {
          timeout: Math.min(timeoutMs, 5000),
        });
      },
    });
    const step = compileStep(
      "core.agent.langchainCode",
      {
        code: "return { doubled: input.value * 2 };",
        language: "javascript",
        mode: "runOnce",
      },
      handlers
    );
    const result = await step.execute({ inputData: { input: { value: 21 } } });
    expect(result["output"]).toEqual({ doubled: 42 });
    expect(result["resource"]).toMatchObject({
      type: "mastra.langchainCode",
    });
  });
});

liveModel("core.agent.chain.* and informationExtractor — live pdm_ai router", () => {
  const generator = async ({
    prompt,
    instructions,
  }: {
    prompt: string;
    instructions?: string;
  }) => {
    const response = await fetch(MODEL!.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${MODEL!.key}`,
      },
      body: JSON.stringify({
        model: MODEL!.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              instructions ??
              "Answer concisely. When JSON is requested, reply with JSON only.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(
        `pdm_ai router returned ${response.status} ${response.statusText}`
      );
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return { text: payload.choices?.[0]?.message?.content ?? "" };
  };

  const handlers = createMastraRagStepHandlers({
    generateText: generator as never,
  });

  it("runs a live basic chain", async () => {
    const step = compileStep(
      "core.agent.chain.basic",
      {
        modelAdapter: MODEL_ADAPTER,
        promptTemplate: "Reply with exactly the word: pong",
      },
      handlers
    );
    const result = await step.execute({
      inputData: { input: "ping" },
    });
    expect(String(result["text"]).toLowerCase()).toContain("pong");
  });

  it("runs a live QA chain over real context", async () => {
    const step = compileStep(
      "core.agent.chain.qa",
      { modelAdapter: MODEL_ADAPTER, returnSourceDocuments: true },
      handlers
    );
    const result = await step.execute({
      inputData: {
        query: "What color is the sky according to the context?",
        context: ["The sky is blue in the provided context."],
      },
    });
    expect(String(result["text"]).toLowerCase()).toContain("blue");
    expect(result["sourceDocuments"]).toEqual([
      "The sky is blue in the provided context.",
    ]);
  });

  it("runs a live summarization chain", async () => {
    const step = compileStep(
      "core.agent.chain.summarization",
      { modelAdapter: MODEL_ADAPTER, instructions: "Summarize in one sentence." },
      handlers
    );
    const result = await step.execute({
      inputData: {
        documents: [
          "The cat sat on the mat.",
          "The dog slept by the fire.",
        ],
      },
    });
    expect(String(result["text"]).length).toBeGreaterThan(0);
  });

  it("extracts structured data with the live information extractor", async () => {
    const step = compileStep(
      "core.agent.informationExtractor",
      {
        modelAdapter: MODEL_ADAPTER,
        instructions:
          'Extract the person name and age. Reply with JSON only, e.g. {"name":"...","age":0}.',
        structuredOutput: { type: "object" },
      },
      handlers
    );
    const result = await step.execute({
      inputData: { text: "Ada Lovelace is 36 years old." },
    });
    expect(result["data"]).toMatchObject({ name: "Ada Lovelace", age: 36 });
  });
});
