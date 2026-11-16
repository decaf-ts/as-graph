/**
 * @module as-graph/tests/integration/mastra/MastraSubAgents.test
 * @summary Sub-agents, delegation hooks and the memory embedding zone.
 * @description A supervisor `core.agent` has a `core.agent.subAgent` on its
 * `subagents` zone; the sub-agent has its own tool and a delegation hook on
 * its `hooks` zone. The suite checks the sub-agent's manifest (an agent
 * without the data ports), the wiring read from the document, the mastra
 * `delegation` config the hooks compile to, and the real `@mastra/core`
 * agents the built-in factory builds. The delegation round trip through a
 * model loop is exercised by `scripts/verify-mastra-agent-zones.cjs`.
 */
import { describe, expect, it } from "@jest/globals";
import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { graphNodeManifest } from "../../../src/shared/graph";
import { AgentNode } from "../../../src/mastra/nodes/agent/node";
import {
  SubAgentNode,
  mastraSubAgentDescriptorOf,
  mastraSubAgentKeyOf,
} from "../../../src/mastra/nodes/agent/sub-agent/node";
import { AgentMemoryNode } from "../../../src/mastra/nodes/memory/memory/node";
import {
  GRAPH_MASTRA_SUBAGENT_WIRING_INVALID,
  connectedMastraZoneWiringOf,
  createMastraGraphAgentFactory,
  mastraDelegationConfigOf,
  type MastraAgentHookEvent,
} from "../../../src/mastra/MastraAgentZones";
import { connectedMastraMemoryWiringOf } from "../../../src/mastra/MastraMemory";
import { GRAPH_MASTRA_MEMORY_EMBEDDING_INVALID } from "../../../src/mastra/types";
import { document, edge, node, port } from "../../../src/workflows/builders";

const MODEL = { provider: "scripted", modelId: "supervisor" };

function supervisorWorkflow(
  extra: { nodes?: ReturnType<typeof node>[]; edges?: ReturnType<typeof edge>[] } = {}
) {
  return document({
    id: "sub-agents",
    outputs: [port("answer")],
    nodes: [
      node("start", "core.trigger.manual"),
      node("supervisor", "core.agent", {
        name: "supervisor",
        instructions: "Delegate stock questions to the clerk.",
        modelAdapter: MODEL,
      }),
      node("clerk", "core.agent.subAgent", {
        name: "stock clerk",
        description: "Answers warehouse stock questions.",
        instructions: "Look stock up with the tool.",
      }),
      node("stock", "core.agent.tool", { toolId: "stock" }),
      node("brief", "core.agent.delegationHook", {
        phase: "start",
        prompt: "Answer in one line. {{prompt}}",
        maxSteps: 2,
      }),
      node("note", "core.agent.delegationHook", {
        phase: "complete",
        feedback: "Clerk answered.",
      }),
      ...(extra.nodes ?? []),
    ],
    edges: [
      edge("e1", ["node", "start", "payload"], ["node", "supervisor", "prompt"]),
      edge("e2", ["node", "supervisor", "response"], ["workflow", "answer"]),
      edge("c1", ["node", "clerk", "parent"], ["node", "supervisor", "subagents"], "connection"),
      edge("c2", ["node", "stock", "tool"], ["node", "clerk", "tools"], "connection"),
      edge("c3", ["node", "brief", "hook"], ["node", "clerk", "hooks"], "connection"),
      edge("c4", ["node", "note", "hook"], ["node", "clerk", "hooks"], "connection"),
      ...(extra.edges ?? []),
    ],
  });
}

const stockTool = createTool({
  id: "stock",
  description: "Stock level of a SKU",
  inputSchema: z.object({ sku: z.string() }),
  execute: async () => ({ quantity: 4217 }),
});

describe("core.agent.subAgent manifest", () => {
  const manifest = graphNodeManifest(SubAgentNode);
  const agent = graphNodeManifest(AgentNode);

  it("is an agent without the prompt/response data ports", () => {
    expect(new SubAgentNode()).toBeInstanceOf(AgentNode);
    expect(manifest.inputs.map((p) => p.id)).not.toContain("prompt");
    expect(manifest.outputs.map((p) => p.id)).toEqual(["resource"]);
    const agentFields = agent.inputs.map((p) => p.id).filter((id) => id !== "prompt");
    expect(manifest.inputs.map((p) => p.id)).toEqual(agentFields);
  });

  it("keeps every agent zone, including nested sub-agents, and adds its parent port", () => {
    const ids = (manifest.connections ?? []).map((p) => p.id);
    for (const zone of (agent.connections ?? []).map((p) => p.id)) {
      expect(ids).toContain(zone);
    }
    const parent = (manifest.connections ?? []).find((p) => p.id === "parent");
    expect(parent?.category).toBe("subagents");
    expect(ids).toContain("subagents");
  });

  it("moves the embedding zone from the agent to the memory node", () => {
    expect((agent.connections ?? []).map((p) => p.id)).not.toContain("embedding");
    const memory = graphNodeManifest(AgentMemoryNode);
    const embedding = (memory.connections ?? []).find((p) => p.id === "embedding");
    expect(embedding?.category).toBe("embedding");
  });

  it("emits a descriptor keyed for mastra's agent-<key> tool", () => {
    const instance = {
      id: "clerk",
      kind: "core.agent.subAgent",
      parameters: { name: "stock clerk!", modelAdapter: { provider: "p", modelId: "m" } },
    };
    expect(mastraSubAgentKeyOf(instance as never)).toBe("stock_clerk");
    expect(mastraSubAgentDescriptorOf(instance as never)).toEqual({
      type: "mastra.subAgent",
      id: "clerk",
      key: "stock_clerk",
      name: "stock clerk!",
      model: "p/m",
    });
  });
});

describe("sub-agent wiring", () => {
  it("reads the sub-agent, its own zones and its delegation hooks", () => {
    const doc = supervisorWorkflow();
    const supervisor = doc.nodes!.find((n) => n.id === "supervisor")!;
    const wiring = connectedMastraZoneWiringOf(doc, supervisor);
    expect(wiring.subAgents).toHaveLength(1);
    const clerk = wiring.subAgents[0];
    expect(clerk.key).toBe("stock_clerk");
    expect(clerk.wiring.tools.map((t) => t.toolId)).toEqual(["stock"]);
    expect(clerk.wiring.delegationHooks.map((h) => [h.nodeId, h.phase])).toEqual([
      ["brief", "start"],
      ["note", "complete"],
    ]);
    expect(clerk.wiring.delegationHooks[0]).toMatchObject({
      prompt: "Answer in one line. {{prompt}}",
      maxSteps: 2,
    });
    expect(wiring.delegationHooks).toEqual([]);
  });

  it("records a deny node at the end of a delegation hook's sub-flow", () => {
    const doc = supervisorWorkflow({
      nodes: [node("deny", "core.agent.toolDeny", { reason: "clerk is off duty" })],
      edges: [edge("d1", ["node", "brief", "value"], ["node", "deny", "value"])],
    });
    const supervisor = doc.nodes!.find((n) => n.id === "supervisor")!;
    const hook = connectedMastraZoneWiringOf(doc, supervisor).subAgents[0].wiring
      .delegationHooks[0];
    expect(hook.deny).toEqual({ nodeId: "deny", reason: "clerk is off duty" });
  });

  it("rejects anything but a sub-agent's parent port on the subagents zone", () => {
    const doc = supervisorWorkflow({
      nodes: [node("other", "core.agent", { modelAdapter: MODEL })],
      edges: [
        edge("bad", ["node", "other", "subagents"], ["node", "supervisor", "subagents"], "connection"),
      ],
    });
    const supervisor = doc.nodes!.find((n) => n.id === "supervisor")!;
    expect(() => connectedMastraZoneWiringOf(doc, supervisor)).toThrow(
      expect.objectContaining({ graphCode: GRAPH_MASTRA_SUBAGENT_WIRING_INVALID })
    );
  });

  it("rejects a sub-agent that delegates to itself", () => {
    const doc = supervisorWorkflow({
      nodes: [node("helper", "core.agent.subAgent", { name: "helper" })],
      edges: [
        edge("n1", ["node", "helper", "parent"], ["node", "clerk", "subagents"], "connection"),
        edge("n2", ["node", "clerk", "parent"], ["node", "helper", "subagents"], "connection"),
      ],
    });
    const supervisor = doc.nodes!.find((n) => n.id === "supervisor")!;
    expect(() => connectedMastraZoneWiringOf(doc, supervisor)).toThrow(
      expect.objectContaining({ graphCode: GRAPH_MASTRA_SUBAGENT_WIRING_INVALID })
    );
  });
});

describe("delegation config", () => {
  function config(denyStart = false, denyComplete = false) {
    const events: MastraAgentHookEvent[] = [];
    const extra = {
      nodes: [
        ...(denyStart ? [node("denyStart", "core.agent.toolDeny", { reason: "no" })] : []),
        ...(denyComplete
          ? [node("denyComplete", "core.agent.toolDeny", { replacement: "REDACTED" })]
          : []),
      ],
      edges: [
        ...(denyStart ? [edge("d1", ["node", "brief", "value"], ["node", "denyStart", "value"])] : []),
        ...(denyComplete
          ? [edge("d2", ["node", "note", "value"], ["node", "denyComplete", "value"])]
          : []),
      ],
    };
    const doc = supervisorWorkflow(extra);
    const supervisor = doc.nodes!.find((n) => n.id === "supervisor")!;
    const wiring = connectedMastraZoneWiringOf(doc, supervisor);
    const delegation = mastraDelegationConfigOf(wiring.subAgents, (event) => {
      events.push(event);
    })!;
    return { delegation, events };
  }

  it("rewrites the prompt and step budget of a delegation to the hooked sub-agent", async () => {
    const { delegation, events } = config();
    await expect(
      delegation.onDelegationStart({ primitiveId: "clerk", prompt: "stock of bolt-m8?" })
    ).resolves.toEqual({
      modifiedPrompt: "Answer in one line. stock of bolt-m8?",
      modifiedMaxSteps: 2,
    });
    expect(events[0]).toMatchObject({
      hookNodeId: "brief",
      type: "delegation",
      toolName: "agent-stock_clerk",
      subAgentId: "clerk",
      denied: false,
    });
    await expect(
      delegation.onDelegationStart({ primitiveId: "someone-else", prompt: "x" })
    ).resolves.toBeUndefined();
  });

  it("rejects a delegation whose start hook ends in a deny node", async () => {
    const { delegation, events } = config(true);
    await expect(
      delegation.onDelegationStart({ primitiveId: "clerk", prompt: "x" })
    ).resolves.toEqual({ proceed: false, rejectionReason: "no" });
    expect(events[0].denied).toBe(true);
  });

  it("adds feedback on completion and replaces a denied result", async () => {
    await expect(
      config().delegation.onDelegationComplete({
        primitiveId: "clerk",
        prompt: "x",
        result: { text: "STOCK=4217" },
      })
    ).resolves.toEqual({ feedback: "Clerk answered." });
    const denied = config(false, true);
    await expect(
      denied.delegation.onDelegationComplete({
        primitiveId: "clerk",
        prompt: "x",
        result: { text: "STOCK=4217" },
      })
    ).resolves.toEqual({ feedback: "Clerk answered.", resultText: "REDACTED" });
    expect(denied.events[0]).toMatchObject({ output: "STOCK=4217", phase: "after" });
  });
});

describe("built-in factory with sub-agents", () => {
  it("builds the sub-agent as a mastra agent registered on the supervisor, with the delegation hooks", async () => {
    const doc = supervisorWorkflow();
    const supervisor = doc.nodes!.find((n) => n.id === "supervisor")!;
    const wiring = connectedMastraZoneWiringOf(doc, supervisor);
    const factory = createMastraGraphAgentFactory({ tools: { stock: stockTool } });
    const agent = (await factory(MODEL, supervisor, [], wiring)) as {
      listAgents: () => Promise<Record<string, unknown>>;
      getDefaultOptions: () => Promise<Record<string, unknown>>;
    };
    const agents = await agent.listAgents();
    expect(Object.keys(agents)).toEqual(["stock_clerk"]);
    const clerk = agents["stock_clerk"] as {
      id: string;
      getDescription: () => string;
      listTools: () => Promise<Record<string, unknown>>;
    };
    expect(clerk.id).toBe("clerk");
    expect(clerk.getDescription()).toBe("Answers warehouse stock questions.");
    expect(Object.keys(await clerk.listTools())).toEqual(["stock"]);
    const defaults = await agent.getDefaultOptions();
    const delegation = defaults["delegation"] as { onDelegationStart?: unknown };
    expect(typeof delegation?.onDelegationStart).toBe("function");
  });

  it("fails closed on a delegation hook attached to a top-level agent", async () => {
    const doc = supervisorWorkflow({
      edges: [edge("c9", ["node", "brief", "hook"], ["node", "supervisor", "hooks"], "connection")],
    });
    const supervisor = doc.nodes!.find((n) => n.id === "supervisor")!;
    const wiring = connectedMastraZoneWiringOf(doc, supervisor);
    await expect(
      createMastraGraphAgentFactory({ tools: { stock: stockTool } })(MODEL, supervisor, [], wiring)
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_SUBAGENT_WIRING_INVALID });
  });
});

describe("memory embedding zone", () => {
  function memoryWorkflow(semanticRecall: boolean, modelAdapter: unknown) {
    return document({
      id: "memory-embedding",
      nodes: [
        node("agent", "core.agent", { modelAdapter: MODEL }),
        node("memory", "core.agent.memory", {
          provider: "memory",
          threadId: "t1",
          semanticRecall,
        }),
        node("embed", "core.agent.embedding", { modelAdapter }),
      ],
      edges: [
        edge("c1", ["node", "memory", "memory"], ["node", "agent", "memory"], "connection"),
        edge("c2", ["node", "embed", "embedding"], ["node", "memory", "embedding"], "connection"),
      ],
    });
  }

  it("attaches the wired embedding model to the memory", () => {
    const doc = memoryWorkflow(true, { provider: "openai", modelId: "text-embedding-3-small" });
    const agent = doc.nodes!.find((n) => n.id === "agent")!;
    const [entry] = connectedMastraMemoryWiringOf(doc, agent);
    expect(entry.embedding).toMatchObject({
      provider: "openai",
      modelId: "text-embedding-3-small",
    });
    expect(entry.embedding?.node.id).toBe("embed");
  });

  it("rejects an embedding on a memory without semantic recall, or without a model", () => {
    const agentOf = (doc: ReturnType<typeof memoryWorkflow>) =>
      doc.nodes!.find((n) => n.id === "agent")!;
    const noRecall = memoryWorkflow(false, { provider: "openai", modelId: "m" });
    expect(() => connectedMastraMemoryWiringOf(noRecall, agentOf(noRecall))).toThrow(
      expect.objectContaining({ graphCode: GRAPH_MASTRA_MEMORY_EMBEDDING_INVALID })
    );
    const noModel = memoryWorkflow(true, {});
    expect(() => connectedMastraMemoryWiringOf(noModel, agentOf(noModel))).toThrow(
      expect.objectContaining({ graphCode: GRAPH_MASTRA_MEMORY_EMBEDDING_INVALID })
    );
  });
});
