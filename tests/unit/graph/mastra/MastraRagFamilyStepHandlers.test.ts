/**
 * @module as-graph/tests/unit/graph/mastra/MastraRagFamilyStepHandlers
 * @summary Unit tests for the SAA-1545 registry coverage of the eleven RAG leaf
 * kinds.
 * @description Pins `MASTRA_RAG_STEP_KINDS` (the eleven RAG kinds) and proves
 * the Mastra node registry — not the neutral default handler set — produces one
 * step per RAG kind. Each step reaches the node class's own `execute()`: the
 * pure chunking kind emits its real `chunks`/`count` output, and every
 * service-backed RAG kind resolves its config-only resource or, for rerank
 * without a host reranker, fails closed with `GRAPH_MASTRA_RAG_UNAVAILABLE`.
 */
import { describe, it, expect } from "@jest/globals";
import {
  MASTRA_RAG_STEP_KINDS,
  MASTRA_DEFAULT_STEP_HANDLER_KINDS,
} from "../../../../src/mastra/MastraDefaultStepHandlers";
import { createMastraNodeStepHandlers } from "../../../../src/mastra/nodes";
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import { GRAPH_MASTRA_RAG_UNAVAILABLE } from "../../../../src/mastra/types";
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

  it("is no longer part of the engine-neutral default handler set", () => {
    const defaults = new Set<string>(MASTRA_DEFAULT_STEP_HANDLER_KINDS);
    for (const kind of MASTRA_RAG_STEP_KINDS) {
      expect({ kind, default: defaults.has(kind) }).toEqual({
        kind,
        default: false,
      });
    }
  });
});

describe("mastra node registry — RAG coverage (SAA-1545)", () => {
  it("returns exactly one registry handler per RAG kind", () => {
    const handlers = createMastraNodeStepHandlers();
    const byKind = new Map(handlers.map((handler) => [handler.kind, handler]));
    for (const kind of MASTRA_RAG_STEP_KINDS) {
      expect(byKind.has(kind)).toBe(true);
    }
    expect(new Set(handlers.map((handler) => handler.kind)).size).toBe(
      handlers.length
    );
  });

  it("compiles a step keyed by the node id for every RAG kind", () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraNodeStepHandlers(),
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

  it("executes each RAG node's real output or typed fail-closed result", async () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraNodeStepHandlers(),
    });
    const { steps } = compiler.compile(ragDocument());

    for (const [index, kind] of RAG_KINDS.entries()) {
      const step = steps.get(`rag-${index}`) as {
        execute: (args: { inputData?: unknown }) => Promise<unknown>;
      };
      if (kind === "core.agent.chunking") {
        const output = await step.execute({ inputData: { probe: index } });
        expect({ kind, output }).toEqual({
          kind,
          output: { chunks: [], count: 0 },
        });
        continue;
      }
      if (kind === "core.agent.rerank") {
        // No host reranker is injected, so the run must fail closed instead of
        // returning an unranked list.
        await expect(
          step.execute({ inputData: { probe: index } })
        ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_RAG_UNAVAILABLE });
        continue;
      }
      const output = (await step.execute({
        inputData: { probe: index },
      })) as { resource?: { kind?: string } };
      expect({ kind, resourceKind: output.resource?.kind }).toEqual({
        kind,
        resourceKind: kind,
      });
    }
  });
});
