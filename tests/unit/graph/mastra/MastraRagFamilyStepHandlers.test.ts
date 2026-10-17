/**
 * @module as-graph/tests/unit/graph/mastra/MastraRagFamilyStepHandlers
 * @summary Unit tests for the SAA-836 M4 mastra default step-handler coverage of
 * the eleven RAG leaf kinds.
 * @description Pins `MASTRA_RAG_STEP_KINDS` (the eleven RAG kinds), that every
 * RAG kind is covered by `MASTRA_DEFAULT_STEP_HANDLER_KINDS` with exactly one
 * handler, and that each compiled RAG step resolves the node's configuration
 * into a `resource` descriptor on its output while forwarding the input — the
 * R9 real-mastra-step contract.
 */
import { describe, it, expect } from "@jest/globals";
import {
  createMastraDefaultStepHandlers,
  MASTRA_RAG_STEP_KINDS,
  MASTRA_DEFAULT_STEP_HANDLER_KINDS,
} from "../../../../src/mastra/MastraDefaultStepHandlers";
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import { document, node } from "../../../../src/workflows/builders";

/** The eleven SAA-836 M4 RAG kinds, in declaration order. */
const RAG_KINDS = [
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
] as const;

/** A canonical document with one node per RAG kind. */
function ragDocument() {
  return document({
    id: "mastra-rag-family-handlers",
    name: "mastra-rag-family-handlers",
    nodes: RAG_KINDS.map((kind, index) =>
      node(`rag-${index}`, kind, { probe: index })
    ),
  });
}

/** The deterministic node id for a RAG kind (its index in the document). */
function nodeIdOf(kind: string): string {
  return `rag-${RAG_KINDS.indexOf(kind as (typeof RAG_KINDS)[number])}`;
}

describe("MASTRA_RAG_STEP_KINDS (SAA-836 M4)", () => {
  it("lists exactly the eleven RAG kinds, unique and in declaration order", () => {
    expect(MASTRA_RAG_STEP_KINDS).toEqual([...RAG_KINDS]);
    expect(new Set(MASTRA_RAG_STEP_KINDS).size).toBe(
      MASTRA_RAG_STEP_KINDS.length
    );
  });

  it("is a subset of the default handler kinds", () => {
    const defaults = new Set<string>(MASTRA_DEFAULT_STEP_HANDLER_KINDS);
    for (const kind of MASTRA_RAG_STEP_KINDS) {
      expect(defaults.has(kind)).toBe(true);
    }
  });
});

describe("mastra default step handlers — RAG coverage (SAA-836 M4)", () => {
  it("returns exactly one handler per RAG kind", () => {
    const handlers = createMastraDefaultStepHandlers();
    const byKind = new Map(handlers.map((handler) => [handler.kind, handler]));
    for (const kind of MASTRA_RAG_STEP_KINDS) {
      expect(byKind.has(kind)).toBe(true);
    }
    expect(handlers).toHaveLength(MASTRA_DEFAULT_STEP_HANDLER_KINDS.length);
  });

  it("compiles a step keyed by the node id for every RAG kind", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const { steps } = compiler.compile(ragDocument());
    for (const kind of RAG_KINDS) {
      const nodeId = nodeIdOf(kind);
      const step = steps.get(nodeId);
      expect({ kind, nodeId, defined: step !== undefined }).toEqual({
        kind,
        nodeId,
        defined: true,
      });
      expect(step?.id).toBe(nodeId);
    }
  });

  it("executes each RAG step forwarding input and resolving the resource", async () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const { steps } = compiler.compile(ragDocument());
    const input = { alpha: 1, nested: { beta: 2 } };

    for (const [index, kind] of RAG_KINDS.entries()) {
      const nodeId = `rag-${index}`;
      const step = steps.get(nodeId) as {
        execute: (args: { inputData?: unknown }) => Promise<unknown>;
      };
      const output = await step.execute({ inputData: input });
      expect(output).toEqual({
        ...input,
        resource: {
          kind,
          nodeId,
          parameters: { probe: index },
        },
      });
    }
  });
});
