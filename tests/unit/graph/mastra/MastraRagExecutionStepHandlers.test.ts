/**
 * @module as-graph/tests/unit/graph/mastra/MastraRagExecutionStepHandlers
 * @summary Unit tests for the SAA-747 Stage 2 real mastra RAG/sandbox step
 * handlers.
 * @description Drives `createMastraRagStepHandlers` through the production
 * `MastraWorkflowCompiler` with fake host ports and a real in-memory
 * `MastraVector`: the vector-store/retriever pair shares one cached store, the
 * chains/extractor run through the generation port with interpolated input, the
 * structured-output parser parses JSON, `queryVector` skips embedding, every
 * kind keeps its config-only R9 descriptor when the document carries no work,
 * and the execution paths fail closed with the typed RAG/sandbox errors.
 */
import { describe, it, expect } from "@jest/globals";
import { createMastraDefaultStepHandlers } from "../../../../src/mastra/MastraDefaultStepHandlers";
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import {
  createMastraRagStepHandlers,
  MASTRA_RAG_EXECUTION_KINDS,
  MASTRA_SANDBOX_EXECUTION_KINDS,
  type MastraEmbeddingConfig,
  type MastraRagTextRequest,
  type MastraSandboxRunRequest,
} from "../../../../src/mastra/MastraRagStepHandlers";
import {
  InMemoryVectorStore,
  type ResolvedMastraVectorStore,
} from "../../../../src/mastra/MastraVectorStore";
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import {
  GRAPH_MASTRA_EMBEDDING_UNAVAILABLE,
  GRAPH_MASTRA_RAG_UNAVAILABLE,
  GRAPH_MASTRA_SANDBOX_TIMEOUT,
  GRAPH_MASTRA_SANDBOX_UNAVAILABLE,
  type MastraNodeStepHandler,
} from "../../../../src/mastra/types";
import { GraphExecutionStatus } from "../../../../src/shared/graph/constants";
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import { document, edge, node } from "../../../../src/workflows/builders";
import { frameBoundSink } from "./helpers";

/** The executable surface a compiled mastra step exposes to these tests. */
interface ExecutableStep {
  execute: (args: {
    inputData?: unknown;
  }) => Promise<Record<string, unknown>>;
}

/** Compiles a document and returns its steps keyed by node id. */
function compileSteps(
  source: GraphWorkflowDocument,
  handlers: MastraNodeStepHandler[]
): Map<string, ExecutableStep> {
  const compiler = new MastraWorkflowCompiler({ stepHandlers: handlers });
  const { steps } = compiler.compile(source);
  return steps as unknown as Map<string, ExecutableStep>;
}

/** Compiles a single node document and returns that node's step. */
function compileStep(
  kind: string,
  parameters: Record<string, unknown>,
  handlers: MastraNodeStepHandler[]
): ExecutableStep {
  const source = document({
    id: `saa-747-rag-${kind.replace(/\./g, "-")}`,
    name: `saa-747-rag-${kind}`,
    nodes: [node("target", kind, parameters)],
  });
  return compileSteps(source, handlers).get("target") as ExecutableStep;
}

/** A fixed, non-secret embedding config used by the fake ports. */
const EMBEDDING: MastraEmbeddingConfig = {
  provider: "fake-embed",
  modelId: "embed-v1",
};

/** A fixed generation model adapter used by the chain/extractor tests. */
const MODEL_ADAPTER = { provider: "fake-model", modelId: "generate-v1" };

/** Every execution kind this handler set owns (RAG + sandbox). */
const EXECUTION_KINDS = [
  ...MASTRA_RAG_EXECUTION_KINDS,
  ...MASTRA_SANDBOX_EXECUTION_KINDS,
] as const;

describe("mastra RAG execution — vector store and retriever (SAA-747 Stage 2)", () => {
  it("embeds, creates the index and upserts into the shared store the retriever reads", async () => {
    const stores: InMemoryVectorStore[] = [];
    const embedRequests: Array<{
      values: string[];
      config: MastraEmbeddingConfig;
      nodeId: string;
    }> = [];

    const handlers = createMastraRagStepHandlers({
      embedText: async (request) => {
        embedRequests.push({
          values: [...request.values],
          config: request.config,
          nodeId: request.node.id,
        });
        return request.values.map((value) => (value === "alpha" ? [1, 0] : [0, 1]));
      },
      // Every resolution hands back a fresh store, so only the handler set's
      // shared cache can make the retriever read the inserted vectors.
      resolveVectorStore: (): ResolvedMastraVectorStore => {
        const store = new InMemoryVectorStore({ id: "memory" });
        stores.push(store);
        return {
          store,
          descriptor: {
            type: "mastra.vectorStore",
            provider: "memory",
            id: "memory",
            indexName: "docs",
          },
        };
      },
    });

    const source = document({
      id: "saa-747-rag-vector-retriever",
      name: "saa-747-rag-vector-retriever",
      nodes: [
        node("store", "core.agent.vectorStore", {
          provider: "memory",
          indexName: "docs",
          dimension: 2,
          embedding: EMBEDDING,
        }),
        node("retriever", "core.agent.retriever", { topK: 2 }),
      ],
      edges: [
        edge("e1", ["node", "store", "resource"], ["node", "retriever", "store"]),
      ],
    });

    const steps = compileSteps(source, handlers);
    const insertStep = steps.get("store") as ExecutableStep;
    const retrieverStep = steps.get("retriever") as ExecutableStep;

    const inserted = await insertStep.execute({
      inputData: { documents: ["alpha", "beta"] },
    });

    expect(embedRequests).toHaveLength(1);
    expect(embedRequests[0]).toEqual({
      values: ["alpha", "beta"],
      config: EMBEDDING,
      nodeId: "store",
    });
    expect(inserted["inserted"]).toEqual(["store-0", "store-1"]);
    expect(inserted["resource"]).toMatchObject({
      kind: "core.agent.vectorStore",
      nodeId: "store",
      type: "mastra.vectorStore",
      provider: "memory",
      id: "docs",
      indexName: "docs",
      dimension: 2,
    });
    expect(await stores[0].listIndexes()).toEqual(["docs"]);
    expect(await stores[0].describeIndex({ indexName: "docs" })).toMatchObject({
      dimension: 2,
      count: 2,
    });

    const retrieved = await retrieverStep.execute({
      inputData: { query: "alpha" },
    });

    // The retriever embedded its query and read the exact store instance the
    // vector-store step inserted into through the handler set's shared cache —
    // the fresh store the second resolution returned was not the one queried.
    expect(stores).toHaveLength(2);
    expect(await stores[1].listIndexes()).toEqual([]);
    expect(embedRequests).toHaveLength(2);
    expect(embedRequests[1]).toMatchObject({
      values: ["alpha"],
      nodeId: "retriever",
    });
    const documents = retrieved["documents"] as Array<{
      id: string;
      text: string;
    }>;
    expect(documents.map((entry) => entry.text)).toEqual(["alpha", "beta"]);
    expect(documents[0].id).toBe("store-0");
    expect(retrieved["resource"]).toMatchObject({
      kind: "core.agent.retriever",
      nodeId: "retriever",
      type: "mastra.retriever",
      topK: 2,
      indexName: "docs",
    });
  });

  it("queries by queryVector without embedding", async () => {
    const store = new InMemoryVectorStore({ id: "memory" });
    await store.createIndex({ indexName: "docs", dimension: 2 });
    await store.upsert({
      indexName: "docs",
      vectors: [[1, 0]],
      ids: ["a"],
      metadata: [{ text: "alpha" }],
    });
    let embedCalls = 0;

    const step = compileStep(
      "core.agent.vectorStore",
      { provider: "memory", indexName: "docs", dimension: 2 },
      createMastraRagStepHandlers({
        embedText: async () => {
          embedCalls += 1;
          throw new Error("queryVector must not embed");
        },
        resolveVectorStore: () => ({
          store,
          descriptor: {
            type: "mastra.vectorStore",
            provider: "memory",
            id: "memory",
            indexName: "docs",
          },
        }),
      })
    );

    const result = await step.execute({
      inputData: { query: "ignored text", queryVector: [1, 0] },
    });

    expect(embedCalls).toBe(0);
    const documents = result["documents"] as Array<{ id: string; text: string }>;
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ id: "a", text: "alpha" });
  });
});

describe("mastra RAG execution — chains and extractors (SAA-747 Stage 2)", () => {
  it("runs basic/qa/summarization through the generator with interpolated prompts", async () => {
    const requests: MastraRagTextRequest[] = [];
    const handlers = createMastraRagStepHandlers({
      generateText: async (request) => {
        requests.push(request);
        return { text: `answer: ${request.prompt}` };
      },
    });

    const source = document({
      id: "saa-747-rag-chains",
      name: "saa-747-rag-chains",
      nodes: [
        node("basic", "core.agent.chain.basic", {
          modelAdapter: MODEL_ADAPTER,
          promptTemplate: "Say {{ input }}",
        }),
        node("qa", "core.agent.chain.qa", {
          modelAdapter: MODEL_ADAPTER,
          promptTemplate: "Context: {{ context }} Q: {{ query }}",
          returnSourceDocuments: true,
        }),
        node("summary", "core.agent.chain.summarization", {
          modelAdapter: MODEL_ADAPTER,
          instructions: "Summarize them",
          documents: ["first document", "second document"],
        }),
      ],
    });

    const steps = compileSteps(source, handlers);

    const basic = await (steps.get("basic") as ExecutableStep).execute({
      inputData: { input: "hello" },
    });
    expect(requests[0]).toMatchObject({
      node: { id: "basic" },
      modelAdapter: MODEL_ADAPTER,
      prompt: "Say hello",
    });
    expect(requests[0].instructions).toBeUndefined();
    expect(basic["text"]).toBe("answer: Say hello");
    expect(basic["resource"]).toMatchObject({
      kind: "core.agent.chain.basic",
      type: "mastra.chain.basic",
      provider: "fake-model",
      modelId: "generate-v1",
    });

    const qa = await (steps.get("qa") as ExecutableStep).execute({
      inputData: {
        query: "who?",
        context: ["Ada", { text: "Lovelace" }],
      },
    });
    expect(requests[1]).toMatchObject({
      node: { id: "qa" },
      modelAdapter: MODEL_ADAPTER,
      prompt: "Context: Ada\n\nLovelace Q: who?",
    });
    expect(qa["text"]).toBe(
      "answer: Context: Ada\n\nLovelace Q: who?"
    );
    expect(qa["sourceDocuments"]).toEqual(["Ada", { text: "Lovelace" }]);

    const summary = await (steps.get("summary") as ExecutableStep).execute({
      inputData: {},
    });
    expect(requests[2]).toMatchObject({
      node: { id: "summary" },
      modelAdapter: MODEL_ADAPTER,
      instructions: "Summarize them",
      prompt: "first document\n\n---\n\nsecond document",
    });
    expect(summary["text"]).toBe(
      "answer: first document\n\n---\n\nsecond document"
    );
    expect(summary["resource"]).toMatchObject({
      type: "mastra.chain.summarization",
      documentCount: 2,
    });
  });

  it("parses structured JSON (including a fenced code block) without a generator", async () => {
    let generateCalls = 0;
    const step = compileStep(
      "core.agent.structuredOutputParser",
      { strict: true, structuredOutput: { type: "object" } },
      createMastraRagStepHandlers({
        generateText: async () => {
          generateCalls += 1;
          return { text: "" };
        },
      })
    );

    const result = await step.execute({
      inputData: { text: "```json\n{\"a\":1,\"nested\":{\"b\":2}}\n```" },
    });

    expect(generateCalls).toBe(0);
    expect(result["object"]).toEqual({ a: 1, nested: { b: 2 } });
    expect(result["resource"]).toEqual({
      kind: "core.agent.structuredOutputParser",
      nodeId: "target",
      type: "mastra.structuredOutputParser",
      strict: true,
      hasSchema: true,
    });
  });

  it("extracts information from generator text JSON and generator objects", async () => {
    const requests: MastraRagTextRequest[] = [];
    const textStep = compileStep(
      "core.agent.informationExtractor",
      {
        modelAdapter: MODEL_ADAPTER,
        instructions: "Extract the person",
        structuredOutput: { type: "object" },
      },
      createMastraRagStepHandlers({
        generateText: async (request) => {
          requests.push(request);
          return { text: "{\"name\":\"Ada\",\"born\":1815}" };
        },
      })
    );

    const fromText = await textStep.execute({
      inputData: { text: "Ada was born in 1815" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      node: { id: "target" },
      modelAdapter: MODEL_ADAPTER,
      instructions: "Extract the person",
      prompt: "Ada was born in 1815",
    });
    expect(fromText["data"]).toEqual({ name: "Ada", born: 1815 });
    expect(fromText["resource"]).toMatchObject({
      kind: "core.agent.informationExtractor",
      type: "mastra.informationExtractor",
      provider: "fake-model",
      modelId: "generate-v1",
      hasSchema: true,
    });

    const objectStep = compileStep(
      "core.agent.informationExtractor",
      { modelAdapter: MODEL_ADAPTER },
      createMastraRagStepHandlers({
        generateText: async () => ({
          text: "ignored",
          object: { name: "Grace" },
        }),
      })
    );
    const fromObject = await objectStep.execute({
      inputData: { text: "Grace wrote the first compiler" },
    });
    expect(fromObject["data"]).toEqual({ name: "Grace" });
  });
});

describe("mastra RAG execution — config-only fallbacks (SAA-747 Stage 2)", () => {
  it("emits the pinned R9 descriptor for every kind without work and calls no port", async () => {
    const calls: string[] = [];
    const handlers = createMastraRagStepHandlers({
      embedText: async () => {
        calls.push("embed");
        return [];
      },
      generateText: async () => {
        calls.push("generate");
        return { text: "" };
      },
      runSandboxedCode: async () => {
        calls.push("sandbox");
        return null;
      },
      resolveVectorStore: () => {
        calls.push("store");
        throw new Error("a config-only node must not resolve a store");
      },
    });

    const source = document({
      id: "saa-747-rag-config-only",
      name: "saa-747-rag-config-only",
      nodes: EXECUTION_KINDS.map((kind) =>
        node(kind.replace(/\./g, "-"), kind)
      ),
    });
    const steps = compileSteps(source, handlers);

    const expectedType: Record<string, string> = {
      "core.agent.embedding": "mastra.embedding",
      "core.agent.vectorStore": "mastra.vectorStore",
      "core.agent.retriever": "mastra.retriever",
      "core.agent.chain.qa": "mastra.chain.qa",
      "core.agent.chain.basic": "mastra.chain.basic",
      "core.agent.chain.summarization": "mastra.chain.summarization",
      "core.agent.structuredOutputParser": "mastra.structuredOutputParser",
      "core.agent.informationExtractor": "mastra.informationExtractor",
      "core.agent.sandbox": "mastra.sandbox",
      "core.agent.langchainCode": "mastra.langchainCode",
    };

    for (const kind of EXECUTION_KINDS) {
      const nodeId = kind.replace(/\./g, "-");
      const step = steps.get(nodeId) as ExecutableStep;
      const output = await step.execute({ inputData: {} });
      const resource = output["resource"] as Record<string, unknown>;
      expect({ kind, nodeId: resource["nodeId"], type: resource["type"] }).toEqual({
        kind,
        nodeId,
        type: expectedType[kind],
      });
      expect(resource["parameters"] ?? {}).toEqual({});
    }

    expect(calls).toEqual([]);
  });

  it("keeps the exact vectorStore/retriever fallback shape without resolving a store", async () => {
    let resolutions = 0;
    const step = compileStep(
      "core.agent.vectorStore",
      {},
      createMastraRagStepHandlers({
        resolveVectorStore: () => {
          resolutions += 1;
          throw new Error("config-only");
        },
      })
    );

    const output = await step.execute({ inputData: { ids: ["ignored"] } });

    expect(resolutions).toBe(0);
    expect(output).toEqual({
      ids: ["ignored"],
      resource: {
        kind: "core.agent.vectorStore",
        nodeId: "target",
        type: "mastra.vectorStore",
        provider: "memory",
        id: "memory",
        indexName: "default",
      },
      inserted: ["ignored"],
      documents: [],
    });
  });
});

describe("mastra RAG execution — fail-closed paths (SAA-747 Stage 2)", () => {
  it("fails closed with GRAPH_MASTRA_EMBEDDING_UNAVAILABLE when documents have no embedding config", async () => {
    const store = new InMemoryVectorStore({ id: "memory" });
    let embedCalls = 0;
    const step = compileStep(
      "core.agent.vectorStore",
      {
        provider: "memory",
        indexName: "docs",
        dimension: 2,
        documents: ["no embedding here"],
      },
      createMastraRagStepHandlers({
        embedText: async () => {
          embedCalls += 1;
          return [];
        },
        resolveVectorStore: () => ({
          store,
          descriptor: {
            type: "mastra.vectorStore",
            provider: "memory",
            id: "memory",
            indexName: "docs",
          },
        }),
      })
    );

    await expect(step.execute({ inputData: {} })).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_EMBEDDING_UNAVAILABLE,
    });
    expect(embedCalls).toBe(0);
  });

  it("fails closed with GRAPH_MASTRA_RAG_UNAVAILABLE when the default model generation fails", async () => {
    const step = compileStep(
      "core.agent.chain.basic",
      {
        modelAdapter: {
          provider: "definitely-not-a-provider-xyz",
          modelId: "missing",
        },
        promptTemplate: "Say {{ input }}",
      },
      createMastraRagStepHandlers()
    );

    await expect(
      step.execute({ inputData: { input: "hello" } })
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_RAG_UNAVAILABLE });
  }, 30_000);

  it("fails closed with GRAPH_MASTRA_SANDBOX_UNAVAILABLE for langchainCode without a runner", async () => {
    const step = compileStep(
      "core.agent.langchainCode",
      { code: "return input;", language: "javascript" },
      createMastraRagStepHandlers()
    );

    await expect(step.execute({ inputData: { input: "x" } })).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_SANDBOX_UNAVAILABLE,
    });
  });

  it("fails closed with GRAPH_CODE_SANDBOX_TIMEOUT when the runner exceeds the ceiling", async () => {
    const requests: MastraSandboxRunRequest[] = [];
    const step = compileStep(
      "core.agent.sandbox",
      { code: "await forever();", timeoutMs: 10 },
      createMastraRagStepHandlers({
        runSandboxedCode: (request) => {
          requests.push(request);
          return new Promise<unknown>(() => {});
        },
      })
    );

    await expect(step.execute({ inputData: { input: 1 } })).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_SANDBOX_TIMEOUT,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      code: "await forever();",
      language: "javascript",
      timeoutMs: 10,
    });
  });

  it("keeps a sandbox node config-only when no runner is wired", async () => {
    const step = compileStep(
      "core.agent.sandbox",
      {
        code: "return 1;",
        isolation: "vm",
        workingDirectory: "/tmp/work",
        timeoutMs: 1234,
      },
      createMastraRagStepHandlers()
    );

    const output = await step.execute({ inputData: { input: 1 } });

    expect(output["result"]).toBeUndefined();
    expect(output["resource"]).toEqual({
      kind: "core.agent.sandbox",
      nodeId: "target",
      parameters: {
        code: "return 1;",
        isolation: "vm",
        workingDirectory: "/tmp/work",
        timeoutMs: 1234,
      },
      type: "mastra.sandbox",
      workingDirectory: "/tmp/work",
      isolation: "vm",
      timeoutMs: 1234,
    });
  });
});

describe("mastra backend RAG registration (SAA-747 Stage 2)", () => {
  it("registers the real RAG handler set after the host default set", async () => {
    const store = new InMemoryVectorStore({ id: "memory" });
    const embedded: string[][] = [];
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
      embedText: async ({ values }) => {
        embedded.push([...values]);
        return values.map(() => [1, 0]);
      },
      resolveVectorStore: () => ({
        store,
        descriptor: {
          type: "mastra.vectorStore",
          provider: "memory",
          id: "memory",
          indexName: "backend-docs",
        },
      }),
    });

    const { sink } = frameBoundSink();
    const result = await backend.execute({
      document: document({
        id: "saa-747-rag-backend",
        name: "saa-747-rag-backend",
        nodes: [
          node("store", "core.agent.vectorStore", {
            provider: "memory",
            indexName: "backend-docs",
            dimension: 2,
            embedding: EMBEDDING,
            documents: ["alpha"],
          }),
        ],
      }),
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(embedded).toEqual([["alpha"]]);
    expect(await store.listIndexes()).toEqual(["backend-docs"]);
  }, 30_000);
});
