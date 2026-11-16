#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * Verifies, against the BUILT package, that an agent node really uses the
 * tool and the skill wired onto its zones, and that a supervisor agent
 * delegates to a sub-agent wired onto its `subagents` zone, through the
 * delegation hooks on the sub-agent's `hooks` zone.
 *
 * A canonical workflow (manual trigger → agent → set) runs on the Mastra
 * engine through `GraphExecutionEngine.execute`. The built-in agent factory
 * builds a real `@mastra/core` Agent, whose real tool loop executes a real
 * mastra tool. Only the language model is scripted (mastra's own V2 mock):
 * turn 1 requests the tool, turn 2 answers from the tool result. No provider
 * credential or network access is needed.
 *
 * Run after `npm run build`:  node scripts/verify-mastra-agent-zones.cjs
 * Exits non-zero when any expectation fails.
 */
const assert = require("node:assert/strict");
const { z } = require("zod");
const { createTool } = require("@mastra/core/tools");
const { Mastra } = require("@mastra/core/mastra");
const { InMemoryStore } = require("@mastra/core/storage");
const {
  MastraLanguageModelV2Mock,
  simulateReadableStream,
} = require("@mastra/core/test-utils/llm-mock");
const { NestFactory } = require("@nestjs/core");
const lib = (name) => require(`../lib/cjs/${name}`);

process.env.MASTRA__OBSERVABILITY__ENABLED = "false";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const lookups = [];
const systemPrompts = [];
const offeredTools = [];
const userPrompts = [];
const supervisorTools = [];
const hookEvents = [];

function scriptedModel() {
  const turn = (options) => {
    const prompt = options.prompt ?? [];
    userPrompts.push(
      JSON.stringify(prompt.filter((message) => message.role === "user"))
    );
    systemPrompts.push(
      prompt
        .filter((message) => message.role === "system")
        .map((message) => String(message.content))
        .join("\n")
    );
    offeredTools.push((options.tools ?? []).map((tool) => tool.name));
    const toolResult = /quantity\\*"\s*:\s*(\d+)/.exec(JSON.stringify(prompt));
    if (!toolResult) {
      return {
        finishReason: "tool-calls",
        parts: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "stock_lookup",
            input: JSON.stringify({ sku: "bolt-m8" }),
          },
        ],
      };
    }
    return {
      finishReason: "stop",
      parts: [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: `STOCK bolt-m8=${toolResult[1]}` },
        { type: "text-end", id: "t1" },
      ],
    };
  };
  return mockModel(turn);
}

/**
 * The supervisor's model: turn 1 delegates to the clerk sub-agent (mastra's
 * `agent-<key>` tool), turn 2 reports the clerk's answer — or that the
 * delegation was rejected.
 */
function supervisorModel() {
  return mockModel((options) => {
    const prompt = JSON.stringify(options.prompt ?? []);
    supervisorTools.push((options.tools ?? []).map((tool) => tool.name));
    const answered = /STOCK bolt-m8=(\d+)/.exec(prompt);
    const text = (value) => ({
      finishReason: "stop",
      parts: [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: value },
        { type: "text-end", id: "t1" },
      ],
    });
    if (/clerk is off duty/.test(prompt)) return text("Clerk unavailable");
    if (answered) return text(`Clerk says: STOCK bolt-m8=${answered[1]}`);
    return {
      finishReason: "tool-calls",
      parts: [
        {
          type: "tool-call",
          toolCallId: "delegate-1",
          toolName: "agent-stock_clerk",
          input: JSON.stringify({ prompt: "How many units of bolt-m8?" }),
        },
      ],
    };
  });
}

function mockModel(turn) {
  return new MastraLanguageModelV2Mock({
    doGenerate: async (options) => {
      const result = turn(options);
      const text = result.parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("");
      return {
        content: text
          ? [{ type: "text", text }]
          : result.parts.filter((part) => part.type === "tool-call"),
        finishReason: result.finishReason,
        usage: USAGE,
        warnings: [],
      };
    },
    doStream: async (options) => {
      const result = turn(options);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "r", modelId: "two-turn" },
            ...result.parts,
            { type: "finish", finishReason: result.finishReason, usage: USAGE },
          ],
        }),
      };
    },
  });
}

const node = (id, kind, parameters = {}) => ({ id, kind, parameters });
const edge = (id, source, target, type = "data") => ({
  id,
  type,
  source: { scope: "node", nodeId: source[0], port: source[1] },
  target:
    target[0] === "$workflow"
      ? { scope: "workflow", port: target[1] }
      : { scope: "node", nodeId: target[0], port: target[1] },
});

const workflow = {
  id: "verify-agent-zones",
  name: "verify-agent-zones",
  inputs: [],
  outputs: [{ id: "answer" }, { id: "summary" }],
  nodes: [
    node("start", "core.trigger.manual"),
    node("agent", "core.agent", {
      name: "stock-clerk",
      instructions: "You answer questions about warehouse stock.",
      modelAdapter: { provider: "scripted", modelId: "two-turn" },
      skillsFormat: "markdown",
    }),
    node("stock", "core.agent.tool", { toolId: "stock_lookup" }),
    node("format", "core.agent.skill", {
      name: "reply-format",
      instructions: "Reply with one line: STOCK <sku>=<quantity>.",
    }),
    node("shape", "core.data.set", {
      includeOtherFields: false,
      assignments: [{ name: "source", type: "string", value: "agent" }],
    }),
  ],
  edges: [
    edge("e1", ["start", "payload"], ["agent", "prompt"]),
    edge("c1", ["stock", "tool"], ["agent", "tools"], "connection"),
    edge("c2", ["format", "skill"], ["agent", "skill"], "connection"),
    edge("e2", ["agent", "response"], ["$workflow", "answer"]),
    edge("e3", ["agent", "response"], ["shape", "value"]),
    edge("e4", ["shape", "result"], ["$workflow", "summary"]),
  ],
};

/** Supervisor → sub-agent (tool) workflow; `deny` rejects the delegation. */
function delegationWorkflow(deny) {
  return {
    id: deny ? "verify-delegation-denied" : "verify-delegation",
    name: deny ? "verify-delegation-denied" : "verify-delegation",
    inputs: [],
    outputs: [{ id: "answer" }],
    nodes: [
      node("start", "core.trigger.manual"),
      node("supervisor", "core.agent", {
        name: "supervisor",
        instructions: "Delegate stock questions to the stock clerk.",
        modelAdapter: { provider: "scripted", modelId: "supervisor" },
      }),
      node("clerk", "core.agent.subAgent", {
        name: "stock clerk",
        description: "Answers warehouse stock questions.",
        instructions: "Look stock up with the stock_lookup tool.",
        modelAdapter: { provider: "scripted", modelId: "two-turn" },
      }),
      node("stock", "core.agent.tool", { toolId: "stock_lookup" }),
      node("brief", "core.agent.delegationHook", {
        phase: "start",
        prompt: "Answer in one line. {{prompt}}",
      }),
      node("note", "core.agent.delegationHook", {
        phase: "complete",
        feedback: "The clerk answered.",
      }),
      ...(deny ? [node("deny", "core.agent.toolDeny", { reason: "clerk is off duty" })] : []),
    ],
    edges: [
      edge("e1", ["start", "payload"], ["supervisor", "prompt"]),
      edge("e2", ["supervisor", "response"], ["$workflow", "answer"]),
      edge("e3", ["start", "payload"], ["brief", "value"]),
      edge("e4", ["start", "payload"], ["note", "value"]),
      edge("c1", ["clerk", "parent"], ["supervisor", "subagents"], "connection"),
      edge("c2", ["stock", "tool"], ["clerk", "tools"], "connection"),
      edge("c3", ["brief", "hook"], ["clerk", "hooks"], "connection"),
      edge("c4", ["note", "hook"], ["clerk", "hooks"], "connection"),
      ...(deny ? [edge("d1", ["brief", "value"], ["deny", "value"])] : []),
    ],
  };
}

async function main() {
  const { createGraphBackendHost } = lib("nest/graph/GraphBackendHost.cjs");
  const { GraphExecutionModule } = lib("nest/graph/GraphExecutionModule.cjs");
  const { GraphExecutionEngine } = lib("engine/execution/GraphExecutionEngine.cjs");
  const { createMastraGraphAgentFactory } = lib("mastra/MastraAgentZones.cjs");

  const stockLookup = createTool({
    id: "stock_lookup",
    description: "Returns the quantity in stock for a SKU.",
    inputSchema: z.object({ sku: z.string() }),
    execute: async (input) => {
      const sku = String(input?.sku ?? input?.context?.sku ?? "");
      lookups.push(sku);
      return { sku, quantity: 4217 };
    },
  });
  const host = await createGraphBackendHost({
    variant: "mastra",
    mastra: {
      mastra: new Mastra({ storage: new InMemoryStore() }),
      createAgent: createMastraGraphAgentFactory({
        tools: { stock_lookup: stockLookup },
        resolveModel: (adapter) =>
          adapter.modelId === "supervisor" ? supervisorModel() : scriptedModel(),
        onHook: (event) => {
          hookEvents.push(event);
        },
      }),
    },
    base: {
      initAdapter: true,
      runs: { auth: "optional", allowAnonymousAccess: true },
      workflows: { auth: "optional", allowAnonymousAccess: true },
      catalogue: { auth: "optional" },
      engines: { auth: "optional" },
    },
  });
  const app = await NestFactory.createApplicationContext(
    GraphExecutionModule.forRoot(host.moduleOptions),
    { logger: false }
  );
  try {
    const engine = app.get(GraphExecutionEngine);
    const result = await engine.execute(workflow, {
      payload: "How many units of SKU bolt-m8 do we have?",
    });
    const failed = Object.values(result.nodeResults)
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.nodeId}: ${entry.error?.message}`);
    assert.deepEqual(failed, [], "no node may fail");
    assert.equal(result.status, "succeeded");
    assert.ok(
      offeredTools[0].includes("stock_lookup"),
      "the tool node must become a tool offered to the model"
    );
    assert.deepEqual(lookups, ["bolt-m8"], "the agent must execute the tool");
    assert.ok(
      systemPrompts[0].includes("### reply-format") &&
        systemPrompts[0].includes("Reply with one line: STOCK <sku>=<quantity>."),
      "the skill node must reach the system prompt"
    );
    assert.equal(result.outputs.answer, "STOCK bolt-m8=4217");
    assert.deepEqual(result.outputs.summary, { source: "agent" });
    console.log("OK agent zones verified");
    console.log("  tools offered to the model :", offeredTools[0].join(", "));
    console.log("  tool executions            :", lookups.join(", "));
    console.log("  model turns                :", systemPrompts.length);
    console.log("  workflow answer            :", result.outputs.answer);

    // --- supervisor delegates to the sub-agent through its hooks ---
    lookups.length = 0;
    userPrompts.length = 0;
    hookEvents.length = 0;
    const delegated = await engine.execute(delegationWorkflow(false), {
      payload: "Ask the clerk about bolt-m8.",
    });
    const delegatedFailed = Object.values(delegated.nodeResults)
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.nodeId}: ${entry.error?.message}`);
    assert.deepEqual(delegatedFailed, [], "no node may fail");
    assert.ok(
      supervisorTools[0].includes("agent-stock_clerk"),
      "the sub-agent must be offered to the supervisor's model as agent-stock_clerk"
    );
    assert.deepEqual(lookups, ["bolt-m8"], "the sub-agent must run its own tool");
    assert.ok(
      userPrompts.some((entry) =>
        entry.includes("Answer in one line. How many units of bolt-m8?")
      ),
      "the start hook must rewrite the prompt the sub-agent receives"
    );
    assert.equal(delegated.outputs.answer, "Clerk says: STOCK bolt-m8=4217");
    assert.deepEqual(
      hookEvents.map((event) => `${event.hookNodeId}:${event.phase}:${event.toolName}`),
      ["brief:before:agent-stock_clerk", "note:after:agent-stock_clerk"],
      "both delegation hooks must fire"
    );
    console.log("OK sub-agent delegation verified");
    console.log("  supervisor tools           :", supervisorTools[0].join(", "));
    console.log("  sub-agent prompt           :", "Answer in one line. How many units of bolt-m8?");
    console.log("  delegation hooks fired     :", hookEvents.map((e) => e.hookNodeId).join(", "));
    console.log("  workflow answer            :", delegated.outputs.answer);

    // --- a start hook ending in a deny node rejects the delegation ---
    lookups.length = 0;
    hookEvents.length = 0;
    const denied = await engine.execute(delegationWorkflow(true), {
      payload: "Ask the clerk about bolt-m8.",
    });
    assert.equal(denied.status, "succeeded");
    assert.deepEqual(lookups, [], "a rejected delegation must not run the sub-agent");
    assert.equal(denied.outputs.answer, "Clerk unavailable");
    assert.equal(hookEvents[0]?.denied, true);
    console.log("OK rejected delegation verified");
    console.log("  workflow answer            :", denied.outputs.answer);
  } finally {
    await app.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("FAILED", error);
    process.exit(1);
  }
);
