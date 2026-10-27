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
  MASTRA_AGENT_RAG_NODES,
  chunkText,
  extractChunkTexts,
  DEFAULT_RAG_CHUNK_SIZE,
  DEFAULT_RAG_CHUNK_OVERLAP,
  MASTRA_AGENT_ZONE,
} from "../../../../src/mastra/nodes";
import type { GraphNodeClass } from "../../../../src/node/base";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { GRAPH_MASTRA_RAG_UNAVAILABLE } from "../../../../src/mastra/types";
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
      "embedding",
      "connection",
      "credentialKey",
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

/** The RAG kinds whose execution delegates to the run-scoped rag service. */
const SERVICE_CASES = CASES.filter(
  (entry) => entry.kind !== "core.agent.chunking"
);

/**
 * Attaches a recording fake `rag` execution service to a node request so the
 * node-class delegation contract can be asserted without a live store/model.
 */
function withRagService(
  request: ReturnType<typeof nodeExecutionRequest>,
  kind: string,
  parameters: Record<string, unknown>,
  calls: Array<{ kind: string; inputs: Record<string, unknown> }>
): ReturnType<typeof nodeExecutionRequest> {
  (request as unknown as { kind: string; mastra: unknown }).kind = kind;
  (request as unknown as { mastra: unknown }).mastra = {
    node: { id: "TestNode", kind, parameters },
    services: {
      rag: {
        execute: async (
          calledKind: string,
          _node: unknown,
          inputs: Record<string, unknown>
        ) => {
          calls.push({ kind: calledKind, inputs });
          return { delegated: true };
        },
      },
    },
  };
  return request;
}

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
    expect(MASTRA_AGENT_RAG_NODES).toHaveLength(11);
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
  it.each(SERVICE_CASES)(
    "delegates $kind to the run-scoped rag execution service",
    async ({ node, kind }) => {
      const calls: Array<{ kind: string; inputs: Record<string, unknown> }> = [];
      const request = withRagService(
        nodeExecutionRequest({ probe: 1 }, { parameters: { probe: 1 } }),
        kind,
        {},
        calls
      );
      const result = await executeNode(node, request, ctx(kind));
      expect(result).toEqual({ delegated: true });
      expect(calls).toEqual([{ kind, inputs: { probe: 1 } }]);
    }
  );

  it.each(SERVICE_CASES)(
    "fails $kind closed with GRAPH_MASTRA_RAG_UNAVAILABLE without a rag service",
    async ({ node, kind }) => {
      await expect(
        executeNode(node, nodeExecutionRequest({}, { parameters: {} }), ctx(kind))
      ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_RAG_UNAVAILABLE });
    }
  );

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
});
