/**
 * @module as-graph/tests/unit/graph/mastra/MastraBuilders
 * @summary Unit tests for the SAA-836 M6 fluent mastra document builders
 * (`MastraAgentBuilder`, `MastraToolBuilder`).
 * @description Proves the builders produce **valid** canonical documents
 * (`build()` runs the same structural gate the engine and frontend share — the
 * built document passes the nine-stage validator over the built-in catalogue),
 * that every zone satellite is wired to the agent's matching zone connection
 * port with a `connection` edge whose ports carry the same category (the
 * connection-category rule), and that the agent/tool parameter tuning methods
 * land on the node's parameters.
 */
import { describe, it, expect } from "@jest/globals";
import {
  AgentHookNode,
  AgentMemoryNode,
  AgentScorerNode,
  AgentToolNode,
} from "../../../../src/node";
import {
  MastraAgentBuilder,
  MastraToolBuilder,
} from "../../../../src/mastra";
import { graphDefinitionOf } from "../../../../src/shared/graph";
import { PortDirection } from "../../../../src/shared/graph/constants";
import { GraphWorkflowDocumentValidator } from "../../../../src/engine/validation/GraphWorkflowDocumentValidator";
import { registerBuiltInGraphNodes } from "../../../../src/engine/catalog/GraphBuiltInRegistrations";
import { assertGraphWorkflowDocumentValid } from "../../../../src/shared/graph/document/GraphWorkflowDocumentBuilder";
import type { GraphNodeCatalogue } from "../../../../src/engine/catalog/GraphNodeCatalogue";
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import { freshCatalogue } from "../engine-fixtures";
import type { MastraAgentZone } from "../../../../src/node";

/** Boots a fresh catalogue with the built-in kinds registered. */
async function builtInCatalogue(): Promise<GraphNodeCatalogue> {
  const catalogue = freshCatalogue();
  await registerBuiltInGraphNodes(catalogue);
  return catalogue;
}

/** Validates a document through the nine-stage gate and returns its result. */
async function validateOf(
  doc: GraphWorkflowDocument,
  catalogue: GraphNodeCatalogue
) {
  const validator = new GraphWorkflowDocumentValidator({ catalogue });
  return validator.validate(doc);
}

/** Re-asserts the builder's own structural gate over a built document. */
function assertStructurallyValid(doc: GraphWorkflowDocument): void {
  expect(() => assertGraphWorkflowDocumentValid(doc)).not.toThrow();
}

/** Resolves the `@connection` port of a node class by category. */
function connectionPortOf(
  ctor: unknown,
  category?: MastraAgentZone
): { name: string; graph?: { handle?: string; category?: string } } {
  const definition = graphDefinitionOf(ctor as never);
  const port = definition.ports.find(
    (candidate) =>
      candidate.direction === PortDirection.CONNECTION &&
      (!category || candidate.graph?.category === category)
  );
  if (!port) throw new Error(`no connection port for ${String(category)}`);
  return port as unknown as {
    name: string;
    graph?: { handle?: string; category?: string };
  };
}

describe("MastraToolBuilder (SAA-836 M6)", () => {
  it("produces a valid tool document with the tuned parameters", () => {
    const doc = new MastraToolBuilder({ id: "tool-doc", toolId: "wrench" })
      .identifiesAs("wrench")
      .describes("Tightens bolts on request")
      .withParameters({ timeoutMs: 25 })
      .build();

    expect(doc.id).toBe("tool-doc");
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0].id).toBe("wrench");
    expect(doc.nodes[0].kind).toBe("core.agent.tool");
    expect(doc.nodes[0].parameters).toMatchObject({
      toolId: "wrench",
      description: "Tightens bolts on request",
      timeoutMs: 25,
    });
  });

  it("defaults the document id, name and tool node id", () => {
    const doc = new MastraToolBuilder().build();
    expect(doc.id).toBe("tool-document");
    expect(doc.name).toBe("tool-document");
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0].id).toBe("tool");
    expect(doc.nodes[0].kind).toBe("core.agent.tool");
  });
});

describe("MastraAgentBuilder (SAA-836 M6)", () => {
  it("produces a valid agent document with the agent node and tuned parameters", () => {
    const doc = new MastraAgentBuilder({ id: "agent-doc" })
      .describes("Chief", "Runs the company")
      .prompt("Do the thing")
      .instructions("Be concise")
      .model("openai", "gpt-4o")
      .maxRetries(2)
      .withAgentParameters({ temperature: 0.2 })
      .build();

    expect(doc.id).toBe("agent-doc");
    expect(doc.nodes.map((node) => node.id)).toEqual(["agent"]);
    const agent = doc.nodes[0];
    expect(agent.kind).toBe("core.agent");
    expect(agent.parameters).toMatchObject({
      name: "Chief",
      description: "Runs the company",
      prompt: "Do the thing",
      instructions: "Be concise",
      modelAdapter: { provider: "openai", modelId: "gpt-4o" },
      maxRetries: 2,
      temperature: 0.2,
    });
  });

  it("wires every zone satellite to the agent's matching zone port with a connection edge", () => {
    const doc = new MastraAgentBuilder({ id: "wired-agent" })
      .withTool(AgentToolNode, { id: "the-tool" })
      .withMemory(AgentMemoryNode, { id: "the-memory" })
      .withScorer(AgentScorerNode, { id: "the-scorer" })
      .withHook(AgentHookNode, { id: "the-hook" })
      .build();

    expect(doc.nodes.map((node) => node.id)).toEqual([
      "agent",
      "the-tool",
      "the-memory",
      "the-scorer",
      "the-hook",
    ]);
    expect(doc.nodes.find((node) => node.id === "the-tool")?.kind).toBe(
      "core.agent.tool"
    );
    expect(doc.nodes.find((node) => node.id === "the-memory")?.kind).toBe(
      "core.agent.memory"
    );
    expect(doc.nodes.find((node) => node.id === "the-scorer")?.kind).toBe(
      "core.agent.scorer"
    );
    expect(doc.nodes.find((node) => node.id === "the-hook")?.kind).toBe(
      "core.agent.hook"
    );

    // per zone: [source node id, satellite class, zone category,
    // satellite connection handle, agent zone port handle]
    const expectedEdges: Array<[string, unknown, string, string, string]> = [
      ["the-tool", AgentToolNode, "tools", "tool", "tools"],
      ["the-memory", AgentMemoryNode, "memory", "memory", "memory"],
      ["the-scorer", AgentScorerNode, "scorers", "scorer", "scorers"],
      ["the-hook", AgentHookNode, "hooks", "hook", "hooks"],
    ];
    expect(doc.edges).toHaveLength(expectedEdges.length);
    for (const [index, [sourceNodeId, satellite, zone, sourceHandle, targetPort]] of expectedEdges.entries()) {
      const edge = doc.edges[index];
      expect({ index, type: edge.type }).toEqual({
        index,
        type: "connection",
      });
      expect(edge.source).toEqual({
        scope: "node",
        nodeId: sourceNodeId,
        port: sourceHandle,
      });
      expect(edge.target).toEqual({
        scope: "node",
        nodeId: "agent",
        port: targetPort,
      });
      // the connection-category rule: both wired ports declare the same zone
      // category, so the edge validator accepts the wiring
      expect(connectionPortOf(satellite as never).graph?.category).toBe(zone);
      expect(
        connectionPortOf(satellite as never).graph?.handle
      ).toBe(sourceHandle);
    }
  });

  it("build() output passes the shared structural gate over the built-in catalogue", async () => {
    const catalogue = await builtInCatalogue();
    const doc = new MastraAgentBuilder({ id: "validated-agent" })
      .prompt("Do the thing")
      .withTool(AgentToolNode)
      .withMemory(AgentMemoryNode, {
        parameters: { provider: "memory", threadId: "thread-1" },
      })
      .withScorer(AgentScorerNode, { parameters: { scorerId: "s1" } })
      .withHook(AgentHookNode, {
        parameters: { value: { passthrough: true } as unknown as never },
      })
      .build();

    // the builder's own structural gate re-asserts clean
    assertStructurallyValid(doc);

    // and the full nine-stage policy gate over the built-in catalogue accepts
    // the wired document (every node participates in a connection edge)
    const result = await validateOf(doc, catalogue);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("build() output for the tool builder passes the shared structural gate", () => {
    const doc = new MastraToolBuilder().build();
    assertStructurallyValid(doc);
    expect(doc.nodes).toHaveLength(1);
  });
});
