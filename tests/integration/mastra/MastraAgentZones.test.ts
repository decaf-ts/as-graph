/**
 * @module as-graph/tests/integration/mastra/MastraAgentZones.test
 * @summary An agent node uses the tool and the skill wired onto its zones.
 * @description The document is a small AI workflow: a manual trigger feeds the
 * agent, the agent has a `core.agent.tool` node on its `tools` zone and a
 * `core.agent.skill` node on its `skill` zone, and an engine-neutral data node
 * consumes its output. The built-in agent factory builds a real
 * `@mastra/core` `Agent`; the suite inspects that agent (its tools and its
 * composed instructions) and replaces only its `generate` call, because
 * mastra's model loop needs VM-module support this Jest configuration does
 * not have. The full tool loop against the built package is exercised by
 * `scripts/verify-mastra-agent-zones.cjs`.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { Test, type TestingModule } from "@nestjs/testing";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";
import {
  GRAPH_MASTRA_AGENT_ZONE_UNSUPPORTED,
  GRAPH_MASTRA_SCORER_UNAVAILABLE,
  GRAPH_MASTRA_TOOL_UNAVAILABLE,
  withMastraToolHooks,
  type MastraAgentHookEvent,
  connectedMastraZoneWiringOf,
  createMastraGraphAgentFactory,
  mastraAgentInstructionsOf,
} from "../../../src/mastra/MastraAgentZones";
import { document, edge, node, port } from "../../../src/workflows/builders";
import {
  resetGraphInjectables,
  resetGraphValueAdapter,
} from "../../unit/graph/engine-fixtures";

const OBSERVABILITY = "MASTRA__OBSERVABILITY__ENABLED";
const MODEL_ADAPTER = { provider: "scripted", modelId: "two-turn" };

function agentWorkflow(
  id: string,
  toolId: string,
  extra: { nodes?: ReturnType<typeof node>[]; edges?: ReturnType<typeof edge>[] } = {}
) {
  return document({
    id,
    outputs: [port("answer"), port("summary")],
    nodes: [
      node("start", "core.trigger.manual"),
      node("agent", "core.agent", {
        name: "stock-clerk",
        instructions: "You answer questions about warehouse stock.",
        modelAdapter: MODEL_ADAPTER,
        skillsFormat: "markdown",
      }),
      node("stock", "core.agent.tool", { toolId }),
      node("format", "core.agent.skill", {
        name: "reply-format",
        description: "How every reply must be written.",
        instructions: "Reply with one line: STOCK <sku>=<quantity>.",
      }),
      node("shape", "core.data.set", {
        includeOtherFields: false,
        assignments: [{ name: "source", type: "string", value: "agent" }],
      }),
      ...(extra.nodes ?? []),
    ],
    edges: [
      edge("e1", ["node", "start", "payload"], ["node", "agent", "prompt"]),
      edge("c1", ["node", "stock", "tool"], ["node", "agent", "tools"], "connection"),
      edge("c2", ["node", "format", "skill"], ["node", "agent", "skill"], "connection"),
      edge("e2", ["node", "agent", "response"], ["workflow", "answer"]),
      edge("e3", ["node", "agent", "response"], ["node", "shape", "value"]),
      edge("e4", ["node", "shape", "result"], ["workflow", "summary"]),
      ...(extra.edges ?? []),
    ],
  });
}

describe("Mastra agent zones", () => {
  let moduleRef: TestingModule;
  let engine: GraphExecutionEngine;
  let observabilityOriginal: string | undefined;
  const built: {
    listTools?: () => unknown;
    getInstructions?: () => unknown;
    generate?: unknown;
  }[] = [];
  const prompts: string[] = [];

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
    const stockLookup = createTool({
      id: "stock_lookup",
      description: "Returns the quantity in stock for a SKU.",
      inputSchema: z.object({ sku: z.string() }),
      execute: async (input: unknown) => {
        const record =
          (input as { context?: { sku?: string }; sku?: string }) ?? {};
        const sku = String(record.sku ?? record.context?.sku ?? "");
        return { sku, quantity: 4217 };
      },
    } as never);
    const host = await createGraphBackendHost({
      variant: "mastra",
      mastra: {
        mastra: runtime,
        createAgent: async (adapter, agentNode, memories, zones) => {
          const agent = (await createMastraGraphAgentFactory({
            tools: { stock_lookup: stockLookup },
            resolveModel: () => ({ scripted: true }),
          })(adapter, agentNode, memories, zones)) as (typeof built)[number];
          built.push(agent);
          agent.generate = async (prompt: string) => {
            prompts.push(prompt);
            return { text: "STOCK bolt-m8=4217", toolCalls: [] };
          };
          return agent;
        },
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

  it("reads the nodes connected to each zone from the document", () => {
    const doc = agentWorkflow("zones-read", "stock_lookup");
    const wiring = connectedMastraZoneWiringOf(
      doc,
      doc.nodes.find((entry) => entry.id === "agent")!
    );
    expect(wiring.tools).toEqual([{ nodeId: "stock", toolId: "stock_lookup" }]);
    expect(wiring.skills).toEqual([
      {
        nodeId: "format",
        name: "reply-format",
        description: "How every reply must be written.",
        instructions: "Reply with one line: STOCK <sku>=<quantity>.",
      },
    ]);
    expect(wiring.hooks).toEqual([]);
  });

  it("renders skills in the node's skillsFormat", () => {
    const skills = [{ nodeId: "s", name: "tone", instructions: "Be brief." }];
    expect(mastraAgentInstructionsOf("Base.", skills, "markdown")).toBe(
      "Base.\n\n## Skills\n\n### tone\nBe brief."
    );
    expect(mastraAgentInstructionsOf("Base.", skills, "xml")).toBe(
      'Base.\n\n<skills>\n  <skill name="tone">Be brief.</skill>\n</skills>'
    );
    expect(mastraAgentInstructionsOf("Base.", [], "xml")).toBe("Base.");
  });

  it("builds an agent that owns the wired tool and skill, and feeds a data node downstream", async () => {
    const result = await engine.execute(
      agentWorkflow("zones-run", "stock_lookup"),
      { payload: "How many units of SKU bolt-m8 do we have?" }
    );
    const failed = Object.values(result.nodeResults)
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.nodeId}: ${entry.error?.message}`);
    expect(failed).toEqual([]);
    expect(result.status).toBe("succeeded");

    const agent = built[built.length - 1];
    // The tool node on the `tools` zone became a tool of the real Agent.
    const tools = (await agent.listTools?.()) as Record<string, unknown>;
    expect(Object.keys(tools ?? {})).toEqual(["stock_lookup"]);
    // The skill node on the `skill` zone was rendered into its instructions.
    const instructions = String(await agent.getInstructions?.());
    expect(instructions).toContain("You answer questions about warehouse stock.");
    expect(instructions).toContain("### reply-format");
    expect(instructions).toContain("Reply with one line: STOCK <sku>=<quantity>.");
    // The trigger payload reached the agent as its prompt…
    expect(prompts).toEqual(["How many units of SKU bolt-m8 do we have?"]);
    // …and the agent's answer flowed into an engine-neutral data node.
    expect(result.outputs.answer).toBe("STOCK bolt-m8=4217");
    expect(result.outputs.summary).toEqual({ source: "agent" });
  }, 60_000);

  it("fails closed when a wired tool is not registered with the host", async () => {
    const result = await engine.execute(
      agentWorkflow("zones-missing-tool", "not_registered"),
      { payload: "anything" }
    );
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.events)).toContain(GRAPH_MASTRA_TOOL_UNAVAILABLE);
  }, 60_000);

  it("fails closed when a wired scorer is not registered with the host", async () => {
    const result = await engine.execute(
      agentWorkflow("zones-scorer", "stock_lookup", {
        nodes: [node("score", "core.agent.scorer", { scorerId: "relevance" })],
        edges: [
          edge("c3", ["node", "score", "scorer"], ["node", "agent", "scorers"], "connection"),
        ],
      }),
      { payload: "anything" }
    );
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.events)).toContain(
      GRAPH_MASTRA_SCORER_UNAVAILABLE
    );
  }, 60_000);

  it("fails closed when a sandbox is wired and no workspace resolver exists", async () => {
    const result = await engine.execute(
      agentWorkflow("zones-sandbox", "stock_lookup", {
        nodes: [node("box", "core.agent.sandbox", { isolation: "none" })],
        edges: [
          edge("c3", ["node", "box", "sandbox"], ["node", "agent", "sandbox"], "connection"),
        ],
      }),
      { payload: "anything" }
    );
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.events)).toContain(
      GRAPH_MASTRA_AGENT_ZONE_UNSUPPORTED
    );
  }, 60_000);

  it("resolves a hook that ends in a tool-deny node, and passes scorers and workspace to the agent", async () => {
    const doc = agentWorkflow("zones-full", "stock_lookup", {
      nodes: [
        node("guard", "core.agent.hook", { phase: "before", toolName: "stock_lookup" }),
        node("deny", "core.agent.toolDeny", { reason: "stock is frozen" }),
        node("audit", "core.agent.hook", { phase: "after" }),
        node("score", "core.agent.scorer", { scorerId: "relevance" }),
        node("box", "core.agent.sandbox", { isolation: "none" }),
      ],
      edges: [
        edge("c3", ["node", "guard", "hook"], ["node", "agent", "hooks"], "connection"),
        edge("d1", ["node", "guard", "value"], ["node", "deny", "value"]),
        edge("c4", ["node", "audit", "hook"], ["node", "agent", "hooks"], "connection"),
        edge("c5", ["node", "score", "scorer"], ["node", "agent", "scorers"], "connection"),
        edge("c6", ["node", "box", "sandbox"], ["node", "agent", "sandbox"], "connection"),
      ],
    });
    const wiring = connectedMastraZoneWiringOf(
      doc,
      doc.nodes.find((entry) => entry.id === "agent")!
    );
    expect(wiring.hooks.map((hook) => [hook.nodeId, hook.phase, hook.deny])).toEqual([
      ["guard", "before", { nodeId: "deny", reason: "stock is frozen" }],
      ["audit", "after", undefined],
    ]);

    const events: unknown[] = [];
    const scorer = { name: "relevance" };
    const workspace = { id: "ws" };
    const calls: unknown[] = [];
    const agent = (await createMastraGraphAgentFactory({
      tools: {
        stock_lookup: { id: "stock_lookup", execute: async (input: unknown) => { calls.push(input); return { quantity: 1 }; } },
      },
      resolveModel: () => ({ scripted: true }),
      resolveScorer: (id) => (id === "relevance" ? scorer : undefined),
      resolveWorkspace: () => workspace,
      onHook: (event) => { events.push(event); },
    })(
      { provider: "scripted", modelId: "two-turn" },
      doc.nodes.find((entry) => entry.id === "agent")!,
      undefined,
      wiring
    )) as { listTools: () => Promise<Record<string, { execute: (input: unknown) => Promise<unknown> }>> };

    // The before-hook ends in a deny node: the tool body never runs.
    const tools = await agent.listTools();
    await expect(tools["stock_lookup"].execute({ sku: "x" })).resolves.toEqual({
      denied: true,
      reason: "stock is frozen",
    });
    expect(calls).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({ hookNodeId: "guard", phase: "before", denied: true }),
    ]);
  });

  it("runs after-hooks around an allowed tool call", async () => {
    const events: MastraAgentHookEvent[] = [];
    const tool = withMastraToolHooks(
      "echo",
      { id: "echo", execute: async (input: unknown) => ({ echoed: input }) },
      [
        { nodeId: "b", kind: "core.agent.hook", parameters: {}, phase: "before" },
        { nodeId: "a", kind: "core.agent.hook", parameters: {}, phase: "after", toolName: "echo" },
        { nodeId: "other", kind: "core.agent.hook", parameters: {}, phase: "after", toolName: "different" },
      ],
      (event) => { events.push(event); }
    ) as { execute: (input: unknown) => Promise<unknown> };
    await expect(tool.execute(1)).resolves.toEqual({ echoed: 1 });
    expect(events.map((event) => [event.hookNodeId, event.phase, event.output])).toEqual([
      ["b", "before", undefined],
      ["a", "after", { echoed: 1 }],
    ]);
  });
});
