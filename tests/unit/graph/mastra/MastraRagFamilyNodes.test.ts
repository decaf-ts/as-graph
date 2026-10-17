/**
 * @module as-graph/tests/unit/graph/mastra/MastraRagFamilyNodes
 * @summary Unit tests for the eleven SAA-836 M4 mastra RAG node kinds
 * (`core.agent.embedding`/`vectorStore`/`retriever`/`chunking`/`rerank`/
 * `chain.qa`/`chain.basic`/`chain.summarization`/`structuredOutputParser`/
 * `informationExtractor`/`langchainCode`).
 * @description Pins the manifest surface (kind, Agent category, ports and the
 * embedding zone connection) and the instance `execute` contract of every RAG
 * node, including the config-only resource descriptors (R9), the model as
 * config (R1), the vector-store provider/id/optional-field resolution, the
 * retriever document passthrough, the chunking strategy suite (`chunkText`,
 * `extractChunkTexts`), the rerank `topN` slice, the chain answer/passthrough
 * contracts, the structured-output JSON parsing and the LangChain Code glue
 * defaults.
 */
import { describe, it, expect } from "@jest/globals";
import { graphNodeManifest } from "../../../../src/shared/graph";
import {
  AgentEmbeddingNode,
  AgentVectorStoreNode,
  AgentRetrieverNode,
  AgentChunkingNode,
  AgentRerankNode,
  AgentQaChainNode,
  AgentBasicChainNode,
  AgentSummarizationChainNode,
  AgentStructuredOutputParserNode,
  AgentInformationExtractorNode,
  AgentLangChainCodeNode,
  GRAPH_AGENT_RAG_NODES,
  chunkText,
  extractChunkTexts,
  DEFAULT_RAG_CHUNK_SIZE,
  DEFAULT_RAG_CHUNK_OVERLAP,
  MASTRA_AGENT_ZONE,
} from "../../../../src/node";
import type { GraphNodeClass } from "../../../../src/node/base";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "../nodes/node-test-utils";

/** One row of the RAG manifest conformance table. */
interface RagCase {
  name: string;
  node: GraphNodeClass;
  kind: string;
  inputs: string[];
  outputs: string[];
  /** `[portId, zoneCategory]`, or `undefined` for the connection-less kinds. */
  connection?: [string, string];
}

const CASES: RagCase[] = [
  {
    name: "embedding",
    node: AgentEmbeddingNode,
    kind: "core.agent.embedding",
    inputs: ["modelAdapter", "dimension", "batchSize"],
    outputs: ["resource"],
    connection: ["embedding", MASTRA_AGENT_ZONE.embedding],
  },
  {
    name: "vectorStore",
    node: AgentVectorStoreNode,
    kind: "core.agent.vectorStore",
    inputs: [
      "provider",
      "storeId",
      "indexName",
      "dimension",
      "metric",
      "connection",
      "credentialRef",
    ],
    outputs: ["resource", "inserted", "documents"],
  },
  {
    name: "retriever",
    node: AgentRetrieverNode,
    kind: "core.agent.retriever",
    inputs: ["store", "query", "queryVector", "filter", "topK", "indexName"],
    outputs: ["documents", "resource"],
  },
  {
    name: "chunking",
    node: AgentChunkingNode,
    kind: "core.agent.chunking",
    inputs: ["strategy", "chunkSize", "chunkOverlap", "separator"],
    outputs: ["chunks", "count"],
  },
  {
    name: "rerank",
    node: AgentRerankNode,
    kind: "core.agent.rerank",
    inputs: ["documents", "query", "modelAdapter", "topN"],
    outputs: ["documents", "resource"],
  },
  {
    name: "chain.qa",
    node: AgentQaChainNode,
    kind: "core.agent.chain.qa",
    inputs: [
      "query",
      "context",
      "modelAdapter",
      "promptTemplate",
      "returnSourceDocuments",
    ],
    outputs: ["text", "sourceDocuments", "resource"],
  },
  {
    name: "chain.basic",
    node: AgentBasicChainNode,
    kind: "core.agent.chain.basic",
    inputs: ["input", "modelAdapter", "promptTemplate"],
    outputs: ["text", "resource"],
  },
  {
    name: "chain.summarization",
    node: AgentSummarizationChainNode,
    kind: "core.agent.chain.summarization",
    inputs: ["documents", "modelAdapter", "strategy", "instructions"],
    outputs: ["text", "resource"],
  },
  {
    name: "structuredOutputParser",
    node: AgentStructuredOutputParserNode,
    kind: "core.agent.structuredOutputParser",
    inputs: ["text", "structuredOutput", "strict"],
    outputs: ["object", "resource"],
  },
  {
    name: "informationExtractor",
    node: AgentInformationExtractorNode,
    kind: "core.agent.informationExtractor",
    inputs: ["text", "modelAdapter", "structuredOutput", "instructions"],
    outputs: ["data", "resource"],
  },
  {
    name: "langchainCode",
    node: AgentLangChainCodeNode,
    kind: "core.agent.langchainCode",
    inputs: ["input", "code", "language", "mode"],
    outputs: ["output", "resource"],
  },
];

describe("Mastra RAG-family nodes — manifest surface (SAA-836 M4)", () => {
  it("exposes exactly the eleven RAG kinds plus their registered constructors", () => {
    expect(CASES.map((entry) => entry.kind)).toEqual([
      "core.agent.embedding",
      "core.agent.vectorStore",
      "core.agent.retriever",
      "core.agent.chunking",
      "core.agent.rerank",
      "core.agent.chain.qa",
      "core.agent.chain.basic",
      "core.agent.chain.summarization",
      "core.agent.structuredOutputParser",
      "core.agent.informationExtractor",
      "core.agent.langchainCode",
    ]);
    expect(GRAPH_AGENT_RAG_NODES).toHaveLength(11);
  });

  it.each(CASES)(
    "$name publishes kind/Agent-category, its ports and its zone connection",
    ({ node, kind, inputs, outputs, connection }) => {
      const manifest = graphNodeManifest(node);
      expect(manifest.kind).toBe(kind);
      expect(manifest.display.category).toBe("Agent");
      expect(manifest.display.labels?.[0]).toBe("agent");
      expect(manifest.inputs.map((port) => port.id)).toEqual(inputs);
      expect(manifest.outputs.map((port) => port.id)).toEqual(outputs);

      const connections = manifest.connections ?? [];
      if (connection) {
        expect(connections.map((port) => port.id)).toEqual([connection[0]]);
        expect(connections[0].category).toBe(connection[1]);
      } else {
        expect(connections).toEqual([]);
      }
    }
  );
});

describe("Mastra RAG-family nodes — execute (SAA-836 M4)", () => {
  const ctx = (kind: string) => buildNodeContext(kind);

  it("embedding resolves the model config (R1) into the mastra embedding resource", async () => {
    const result = await executeNode(
      AgentEmbeddingNode,
      nodeExecutionRequest(
        {},
        {
          parameters: {
            modelAdapter: { provider: "openai", modelId: "text-embedding-3-small" },
            dimension: 1536,
            batchSize: 100,
          },
        }
      ),
      ctx("core.agent.embedding")
    );
    expect(result).toEqual({
      resource: {
        type: "mastra.embedding",
        provider: "openai",
        modelId: "text-embedding-3-small",
        dimension: 1536,
        batchSize: 100,
        input: {},
      },
    });
  });

  it("embedding leaves the provider/modelId undefined without a modelAdapter", async () => {
    const result = await executeNode(
      AgentEmbeddingNode,
      nodeExecutionRequest({}, { parameters: {} }),
      ctx("core.agent.embedding")
    );
    expect(result).toEqual({
      resource: {
        type: "mastra.embedding",
        provider: undefined,
        modelId: undefined,
        dimension: undefined,
        batchSize: undefined,
        input: {},
      },
    });
  });

  it("vectorStore resolves the provider config into the store resource (R9)", async () => {
    const inputs = { ids: ["a", "b"], documents: [{ text: "x" }] };
    const result = await executeNode(
      AgentVectorStoreNode,
      nodeExecutionRequest(inputs, {
        parameters: {
          provider: "pgvector",
          storeId: "vs-1",
          indexName: "docs",
          dimension: 1536,
          metric: "cosine",
          credentialRef: { env: "PGVECTOR_URL" },
        },
      }),
      ctx("core.agent.vectorStore")
    );
    expect(result).toEqual({
      resource: {
        type: "mastra.vectorStore",
        provider: "pgvector",
        id: "vs-1",
        indexName: "docs",
        dimension: 1536,
        metric: "cosine",
        credentialRef: { env: "PGVECTOR_URL" },
      },
      inserted: ["a", "b"],
      documents: [{ text: "x" }],
    });
  });

  it("vectorStore defaults to the in-memory provider and omits unset optional fields", async () => {
    const result = await executeNode(
      AgentVectorStoreNode,
      nodeExecutionRequest({}, { parameters: {} }),
      ctx("core.agent.vectorStore")
    );
    expect(result).toEqual({
      resource: { type: "mastra.vectorStore", provider: "memory", id: "memory" },
      inserted: [],
      documents: [],
    });
  });

  it("vectorStore falls back to the index name for the store id and ignores non-array ids", async () => {
    const byIndex = await executeNode(
      AgentVectorStoreNode,
      nodeExecutionRequest({}, { parameters: { indexName: "docs" } }),
      ctx("core.agent.vectorStore")
    );
    expect((byIndex["resource"] as { id: unknown }).id).toBe("docs");

    const noIds = await executeNode(
      AgentVectorStoreNode,
      nodeExecutionRequest({ ids: "not-an-array" }, { parameters: {} }),
      ctx("core.agent.vectorStore")
    );
    expect(noIds["inserted"]).toEqual([]);
  });

  it("retriever forwards the retrieved documents and resolves the retriever resource", async () => {
    const inputs = {
      store: { type: "mastra.vectorStore", provider: "pgvector" },
      query: "what is rag?",
      documents: ["d1", "d2"],
    };
    const result = await executeNode(
      AgentRetrieverNode,
      nodeExecutionRequest(inputs, { parameters: { topK: 5, indexName: "docs" } }),
      ctx("core.agent.retriever")
    );
    expect(result).toEqual({
      documents: ["d1", "d2"],
      resource: {
        type: "mastra.retriever",
        topK: 5,
        indexName: "docs",
        store: inputs.store,
        input: inputs,
      },
    });
  });

  it("retriever normalizes a missing/invalid documents input to an empty array", async () => {
    const result = await executeNode(
      AgentRetrieverNode,
      nodeExecutionRequest(
        { store: null, query: "q", documents: "not-an-array" },
        { parameters: {} }
      ),
      ctx("core.agent.retriever")
    );
    expect(result["documents"]).toEqual([]);
  });

  it("rerank slices the documents to topN and resolves the reranker resource", async () => {
    const result = await executeNode(
      AgentRerankNode,
      nodeExecutionRequest(
        { documents: ["a", "b", "c"], query: "q" },
        {
          parameters: {
            topN: 2,
            modelAdapter: { provider: "openai", modelId: "gpt-4o-mini" },
          },
        }
      ),
      ctx("core.agent.rerank")
    );
    expect(result).toEqual({
      documents: ["a", "b"],
      resource: {
        type: "mastra.rerank",
        provider: "openai",
        modelId: "gpt-4o-mini",
        topN: 2,
      },
    });
  });

  it("rerank keeps every document without a valid topN", async () => {
    for (const topN of [undefined, 0, -1, "many"]) {
      const result = await executeNode(
        AgentRerankNode,
        nodeExecutionRequest(
          { documents: ["a", "b"] },
          { parameters: { topN: topN as never } }
        ),
        ctx("core.agent.rerank")
      );
      expect(result["documents"]).toEqual(["a", "b"]);
      expect((result["resource"] as { topN: unknown }).topN).toBeUndefined();
    }
  });

  it("chunking splits with the default recursive strategy on the separator", async () => {
    expect(chunkText("a\n\nb\n\nc")).toEqual(["a", "b", "c"]);
    expect(chunkText("short")).toEqual(["short"]);
    expect(chunkText("")).toEqual([]);
  });

  it("chunkText slices with the character strategy honouring the overlap", () => {
    expect(chunkText("abcdef", { strategy: "character", chunkSize: 4, chunkOverlap: 1 }))
      .toEqual(["abcd", "def"]);
    expect(chunkText("abc", { strategy: "character", chunkSize: 2, chunkOverlap: 0 }))
      .toEqual(["ab", "c"]);
  });

  it("chunkText joins whitespace tokens with the token strategy", () => {
    expect(
      chunkText("one two three four", {
        strategy: "token",
        chunkSize: 3,
        chunkOverlap: 0,
      })
    ).toEqual(["one two three", "four"]);
    // the default overlap is clamped below the chunk size (step 1 here)
    expect(chunkText("one two three four", { strategy: "token", chunkSize: 3 }))
      .toEqual(["one two three", "two three four"]);
    expect(chunkText("   ", { strategy: "token", chunkSize: 2 })).toEqual([]);
  });

  it("chunkText splits markdown on headers and recursive on a custom separator", () => {
    expect(
      chunkText("# Title\nbody\n# Second\nmore", { strategy: "markdown" })
    ).toEqual(["# Title\nbody", "Second\nmore"]);
    expect(chunkText("a|b|c", { separator: "|" })).toEqual(["a", "b", "c"]);
  });

  it("chunkText clamps the overlap below the chunk size and falls back for invalid values", () => {
    // an overlap >= chunkSize would loop forever; it is clamped to chunkSize-1
    expect(chunkText("ab", { strategy: "character", chunkSize: 1, chunkOverlap: 5 }))
      .toEqual(["a", "b"]);
    expect(chunkText("a\n\nb", { chunkSize: "big" as never })).toEqual([
      "a",
      "b",
    ]);
    expect(DEFAULT_RAG_CHUNK_SIZE).toBe(1000);
    expect(DEFAULT_RAG_CHUNK_OVERLAP).toBe(200);
    expect(chunkText("x", { chunkOverlap: -5 })).toEqual(["x"]);
  });

  it("extractChunkTexts reads the text input plus string and {text} documents", () => {
    expect(
      extractChunkTexts({
        text: "t1",
        documents: ["d1", { text: "d2" }, { noText: true }, 42, null],
      })
    ).toEqual(["t1", "d1", "d2"]);
    expect(extractChunkTexts({})).toEqual([]);
  });

  it("chunking executes to chunks and their count from text and documents", async () => {
    const result = await executeNode(
      AgentChunkingNode,
      nodeExecutionRequest(
        { text: "a\n\nb", documents: [{ text: "c\nd" }] },
        { parameters: { strategy: "character", chunkSize: 2, chunkOverlap: 0 } }
      ),
      ctx("core.agent.chunking")
    );
    expect(result).toEqual({
      chunks: ["a\n", "\nb", "c\n", "d"],
      count: 4,
    });
  });

  it("qa chain answers with the text and honours the source-document toggle", async () => {
    const withSources = await executeNode(
      AgentQaChainNode,
      nodeExecutionRequest(
        { query: "q", context: ["c1"], text: "answer" },
        {
          parameters: {
            modelAdapter: { provider: "openai", modelId: "gpt-4o-mini" },
            returnSourceDocuments: true,
          },
        }
      ),
      ctx("core.agent.chain.qa")
    );
    expect(withSources).toEqual({
      text: "answer",
      sourceDocuments: ["c1"],
      resource: {
        type: "mastra.chain.qa",
        provider: "openai",
        modelId: "gpt-4o-mini",
        returnSourceDocuments: true,
      },
    });

    const withoutSources = await executeNode(
      AgentQaChainNode,
      nodeExecutionRequest(
        { query: "q", documents: ["d1"], text: "answer" },
        { parameters: {} }
      ),
      ctx("core.agent.chain.qa")
    );
    expect(withoutSources["sourceDocuments"]).toEqual([]);
    expect(
      (withoutSources["resource"] as { returnSourceDocuments: unknown })
        .returnSourceDocuments
    ).toBe(false);
  });

  it("qa chain falls back to the documents input as context and blanks non-string text", async () => {
    const fromDocuments = await executeNode(
      AgentQaChainNode,
      nodeExecutionRequest(
        { query: "q", documents: ["d1"], text: "answer" },
        { parameters: { returnSourceDocuments: true } }
      ),
      ctx("core.agent.chain.qa")
    );
    expect(fromDocuments["sourceDocuments"]).toEqual(["d1"]);

    const result = await executeNode(
      AgentQaChainNode,
      nodeExecutionRequest({ query: "q", documents: ["d1"], text: 42 }, {}),
      ctx("core.agent.chain.qa")
    );
    // the toggle stays off unless configured
    expect(result["sourceDocuments"]).toEqual([]);
    expect(result["text"]).toBe("");
  });

  it("basic chain passes the text through and resolves the chain resource", async () => {
    const result = await executeNode(
      AgentBasicChainNode,
      nodeExecutionRequest(
        { input: "hi", text: "hello" },
        {
          parameters: {
            modelAdapter: { provider: "openai", modelId: "gpt-4o-mini" },
            promptTemplate: "Say {input}",
          },
        }
      ),
      ctx("core.agent.chain.basic")
    );
    expect(result).toEqual({
      text: "hello",
      resource: {
        type: "mastra.chain.basic",
        provider: "openai",
        modelId: "gpt-4o-mini",
        promptTemplate: "Say {input}",
      },
    });
  });

  it("summarization resolves the strategy and document count", async () => {
    const byStrategy = await executeNode(
      AgentSummarizationChainNode,
      nodeExecutionRequest(
        { documents: ["a", "b"], text: "summary" },
        {
          parameters: {
            strategy: "map_reduce",
            modelAdapter: { provider: "deepseek", modelId: "deepseek-chat" },
          },
        }
      ),
      ctx("core.agent.chain.summarization")
    );
    expect(byStrategy).toEqual({
      text: "summary",
      resource: {
        type: "mastra.chain.summarization",
        provider: "deepseek",
        modelId: "deepseek-chat",
        strategy: "map_reduce",
        documentCount: 2,
      },
    });

    const defaulted = await executeNode(
      AgentSummarizationChainNode,
      nodeExecutionRequest({ documents: "not-an-array", text: "s" }, {}),
      ctx("core.agent.chain.summarization")
    );
    expect(
      (defaulted["resource"] as Record<string, unknown>)
    ).toEqual({
      type: "mastra.chain.summarization",
      provider: undefined,
      modelId: undefined,
      strategy: "stuff",
      documentCount: 0,
    });
  });

  it("structuredOutputParser parses JSON and reports null for invalid text", async () => {
    const valid = await executeNode(
      AgentStructuredOutputParserNode,
      nodeExecutionRequest({ text: '{"a":1}' }, { parameters: { strict: true } }),
      ctx("core.agent.structuredOutputParser")
    );
    expect(valid["object"]).toEqual({ a: 1 });
    expect(valid["resource"]).toEqual({
      type: "mastra.structuredOutputParser",
      strict: true,
      hasSchema: false,
    });

    for (const text of ["not json", "", 42, undefined]) {
      const invalid = await executeNode(
        AgentStructuredOutputParserNode,
        nodeExecutionRequest({ text }, {}),
        ctx("core.agent.structuredOutputParser")
      );
      expect(invalid["object"]).toBeNull();
    }

    const viaInput = await executeNode(
      AgentStructuredOutputParserNode,
      nodeExecutionRequest({ input: "[1,2]" }, {}),
      ctx("core.agent.structuredOutputParser")
    );
    expect(viaInput["object"]).toEqual([1, 2]);

    const withSchema = await executeNode(
      AgentStructuredOutputParserNode,
      nodeExecutionRequest(
        { text: "{}" },
        { parameters: { structuredOutput: { type: "object" } } }
      ),
      ctx("core.agent.structuredOutputParser")
    );
    expect(
      (withSchema["resource"] as { hasSchema: unknown }).hasSchema
    ).toBe(true);
  });

  it("informationExtractor forwards the extracted data and resolves the extractor resource", async () => {
    const result = await executeNode(
      AgentInformationExtractorNode,
      nodeExecutionRequest(
        { text: "raw", data: { name: "Ada" } },
        {
          parameters: {
            modelAdapter: { provider: "openai", modelId: "gpt-4o-mini" },
            instructions: "Extract people",
            structuredOutput: { type: "object" },
          },
        }
      ),
      ctx("core.agent.informationExtractor")
    );
    expect(result).toEqual({
      data: { name: "Ada" },
      resource: {
        type: "mastra.informationExtractor",
        provider: "openai",
        modelId: "gpt-4o-mini",
        instructions: "Extract people",
        hasSchema: true,
      },
    });

    const noData = await executeNode(
      AgentInformationExtractorNode,
      nodeExecutionRequest({ text: "raw" }, {}),
      ctx("core.agent.informationExtractor")
    );
    expect(noData["data"]).toBeNull();
  });

  it("langchainCode defaults to javascript/runOnce and flags authored code", async () => {
    const configured = await executeNode(
      AgentLangChainCodeNode,
      nodeExecutionRequest(
        { input: "value" },
        { parameters: { code: "return input;", language: "typescript", mode: "runAll" } }
      ),
      ctx("core.agent.langchainCode")
    );
    expect(configured).toEqual({
      output: "value",
      resource: {
        type: "mastra.langchainCode",
        language: "typescript",
        mode: "runAll",
        hasCode: true,
      },
    });

    const defaulted = await executeNode(
      AgentLangChainCodeNode,
      nodeExecutionRequest({}, { parameters: {} }),
      ctx("core.agent.langchainCode")
    );
    expect(defaulted).toEqual({
      output: null,
      resource: {
        type: "mastra.langchainCode",
        language: "javascript",
        mode: "runOnce",
        hasCode: false,
      },
    });
  });
});
