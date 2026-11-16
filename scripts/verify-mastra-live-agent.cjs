#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/**
 * Live-model checks of the AI workflow path, kept deliberately small.
 *
 * Three workflows run on the Mastra engine, against the BUILT package and the
 * real `pdm_ai` provider (model `DeepSeek-V4.1-Flash`). The connection is
 * read from the developer's opencode config (`~/.config/opencode/opencode.json`)
 * or from `PDM_AI_BASE_URL` / `PDM_AI_API_KEY`:
 *
 *   1. an agent that must call a tool wired through a `core.agent.tool` node
 *      and answer in the format a wired `core.agent.skill` node dictates;
 *   2. an agent whose answer is post-processed by a Code node (host-side code
 *      on the Mastra engine) and a data node;
 *   3. a supervisor agent that delegates to a `core.agent.subAgent` (which
 *      owns the tool), through a delegation hook that rewrites the prompt.
 *
 * Token use is bounded on purpose: one-line prompts and instructions, a
 * 64-token output cap, at most three model steps per agent, three workflows.
 * A real mastra Agent loop needs ESM-only dependencies Jest cannot load, so
 * this is a plain Node script.
 *
 * Run after `npm run build`:  npm run test:live
 * Exits 0 when the checks pass or no provider credential is available
 * (skipped), non-zero when a check fails.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { z } = require("zod");
const { createTool } = require("@mastra/core/tools");
const { Mastra } = require("@mastra/core/mastra");
const { InMemoryStore } = require("@mastra/core/storage");
const { NestFactory } = require("@nestjs/core");
const lib = (name) => require(`../lib/cjs/${name}`);

process.env.MASTRA__OBSERVABILITY__ENABLED = "false";

const PROVIDER = "pdm_ai";
const MODEL_ID = "DeepSeek-V4.1-Flash";
const MODEL_ADAPTER = { provider: PROVIDER, modelId: MODEL_ID };
/** Hard caps applied to every agent call of this script. */
const AGENT_OPTIONS = {
  defaultOptions: { maxSteps: 3, modelSettings: { maxOutputTokens: 64 } },
};

function resolveValue(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const match = /^\{env:([A-Za-z0-9_]+)\}$/.exec(value);
  return match ? process.env[match[1]] : value;
}

function providerConnection() {
  let baseURL = process.env.PDM_AI_BASE_URL;
  let apiKey = process.env.PDM_AI_API_KEY;
  try {
    const file = path.join(
      process.env.HOME ?? "",
      ".config",
      "opencode",
      "opencode.json"
    );
    if (fs.existsSync(file)) {
      const options =
        JSON.parse(fs.readFileSync(file, "utf8")).provider?.[PROVIDER]
          ?.options ?? {};
      baseURL = baseURL ?? resolveValue(options.baseURL);
      apiKey = apiKey ?? resolveValue(options.apiKey);
    }
  } catch {
    // An unreadable config simply leaves the connection unresolved.
  }
  return baseURL && apiKey ? { baseURL, apiKey } : undefined;
}

const node = (id, kind, parameters = {}, extra = {}) => ({
  id,
  kind,
  parameters,
  ...extra,
});
const edge = (id, source, target, type = "data") => ({
  id,
  type,
  source: { scope: "node", nodeId: source[0], port: source[1] },
  target:
    target[0] === "$workflow"
      ? { scope: "workflow", port: target[1] }
      : { scope: "node", nodeId: target[0], port: target[1] },
});

function assertNoFailures(result) {
  const failed = Object.values(result.nodeResults)
    .filter((entry) => entry.status === "failed")
    .map((entry) => `${entry.nodeId}: ${entry.error?.message}`);
  assert.deepEqual(failed, [], "no node may fail");
  assert.equal(result.status, "succeeded");
}

async function main() {
  const connection = providerConnection();
  if (!connection) {
    console.log("SKIPPED no pdm_ai provider credential is available");
    return;
  }
  const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
  const provider = createOpenAICompatible({ name: PROVIDER, ...connection });
  const { createGraphBackendHost } = lib("nest/graph/GraphBackendHost.cjs");
  const { GraphExecutionModule } = lib("nest/graph/GraphExecutionModule.cjs");
  const { GraphExecutionEngine } = lib(
    "engine/execution/GraphExecutionEngine.cjs"
  );
  const { createMastraGraphAgentFactory } = lib("mastra/MastraAgentZones.cjs");

  const lookups = [];
  const hookEvents = [];
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
        resolveModel: (adapter) => provider(adapter.modelId),
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

    // 1. tool node on the `tools` zone + skill node on the `skill` zone
    const toolRun = await engine.execute(
      {
        id: "live-agent-tool-skill",
        name: "live-agent-tool-skill",
        inputs: [],
        outputs: [{ id: "answer" }],
        nodes: [
          node("start", "core.trigger.manual"),
          node("agent", "core.agent", {
            name: "stock-clerk",
            instructions: "Look stock up with the tool. Never guess.",
            modelAdapter: MODEL_ADAPTER,
            agentOptions: AGENT_OPTIONS,
          }),
          node("stock", "core.agent.tool", { toolId: "stock_lookup" }),
          node("format", "core.agent.skill", {
            name: "reply-format",
            instructions: "Reply with exactly: STOCK <sku>=<quantity>",
          }),
        ],
        edges: [
          edge("e1", ["start", "payload"], ["agent", "prompt"]),
          edge("c1", ["stock", "tool"], ["agent", "tools"], "connection"),
          edge("c2", ["format", "skill"], ["agent", "skill"], "connection"),
          edge("e2", ["agent", "response"], ["$workflow", "answer"]),
        ],
      },
      { payload: "Stock for SKU bolt-m8?" }
    );
    assertNoFailures(toolRun);
    const answer = String(toolRun.outputs.answer);
    assert.ok(
      lookups.some((sku) => sku.toLowerCase() === "bolt-m8"),
      `the model must call the wired tool (lookups: ${JSON.stringify(lookups)})`
    );
    assert.ok(
      answer.includes("4217"),
      `the tool result must be in the answer: ${answer}`
    );
    assert.ok(
      /STOCK/i.test(answer),
      `the wired skill's format must be followed: ${answer}`
    );
    console.log("OK 1/3 tool + skill   →", answer.trim());

    // 2. agent → Code node (host-side code on Mastra) → data node
    const codeRun = await engine.execute(
      {
        id: "live-agent-code",
        name: "live-agent-code",
        inputs: [],
        outputs: [{ id: "report" }],
        nodes: [
          node("start", "core.trigger.manual"),
          node("agent", "core.agent", {
            instructions: "Answer with one integer and nothing else.",
            modelAdapter: MODEL_ADAPTER,
            agentOptions: AGENT_OPTIONS,
          }),
          node(
            "parse",
            "core.utility.code",
            {},
            {
              inputBindings: {
                code: {
                  mode: "literal",
                  value:
                    "const n = Number(String($input.data).match(/-?\\d+/)?.[0]); return { n, doubled: n * 2 };",
                },
              },
            }
          ),
          node("label", "core.data.set", {
            includeOtherFields: true,
            assignments: [{ name: "source", type: "string", value: "llm" }],
          }),
        ],
        edges: [
          edge("e1", ["start", "payload"], ["agent", "prompt"]),
          edge("e2", ["agent", "response"], ["parse", "data"]),
          edge("e3", ["parse", "result"], ["label", "value"]),
          edge("e4", ["label", "result"], ["$workflow", "report"]),
        ],
      },
      { payload: "What is 19 + 23?" }
    );
    assertNoFailures(codeRun);
    assert.deepEqual(codeRun.outputs.report, {
      n: 42,
      doubled: 84,
      source: "llm",
    });
    console.log("OK 2/3 agent → code   →", JSON.stringify(codeRun.outputs.report));

    // 3. supervisor → sub-agent (owns the tool), delegation hook on the sub-agent
    lookups.length = 0;
    const delegationRun = await engine.execute(
      {
        id: "live-agent-sub-agent",
        name: "live-agent-sub-agent",
        inputs: [],
        outputs: [{ id: "answer" }],
        nodes: [
          node("start", "core.trigger.manual"),
          node("supervisor", "core.agent", {
            name: "supervisor",
            instructions:
              "Always ask the stock clerk agent; never answer stock questions yourself. Repeat its answer.",
            modelAdapter: MODEL_ADAPTER,
            // One extra step: a supervisor that re-delegates once must still
            // have a step left to answer.
            agentOptions: {
              defaultOptions: { ...AGENT_OPTIONS.defaultOptions, maxSteps: 4 },
            },
          }),
          node("clerk", "core.agent.subAgent", {
            name: "stock_clerk",
            description: "Knows warehouse stock levels.",
            instructions: "Look stock up with the tool. Reply: STOCK <sku>=<quantity>",
            agentOptions: AGENT_OPTIONS,
          }),
          node("stock", "core.agent.tool", { toolId: "stock_lookup" }),
          node("brief", "core.agent.delegationHook", {
            phase: "start",
            prompt: "One line only. {{prompt}}",
          }),
        ],
        edges: [
          edge("e1", ["start", "payload"], ["supervisor", "prompt"]),
          edge("e2", ["start", "payload"], ["brief", "value"]),
          edge("c1", ["clerk", "parent"], ["supervisor", "subagents"], "connection"),
          edge("c2", ["stock", "tool"], ["clerk", "tools"], "connection"),
          edge("c3", ["brief", "hook"], ["clerk", "hooks"], "connection"),
          edge("e3", ["supervisor", "response"], ["$workflow", "answer"]),
        ],
      },
      { payload: "Stock for SKU bolt-m8?" }
    );
    assertNoFailures(delegationRun);
    const delegated = String(delegationRun.outputs.answer);
    assert.ok(
      hookEvents.some((event) => event.type === "delegation" && event.hookNodeId === "brief"),
      "the supervisor must delegate to the sub-agent (the delegation hook fires)"
    );
    assert.ok(
      lookups.some((sku) => sku.toLowerCase() === "bolt-m8"),
      `the sub-agent must call its tool (lookups: ${JSON.stringify(lookups)})`
    );
    // The supervisor rephrases freely ("4,217 units"): match the digits.
    assert.ok(
      /4[,.\s]?217/.test(delegated),
      `the sub-agent's answer must reach the supervisor: "${delegated}" (delegations: ${hookEvents.filter((e) => e.type === "delegation").length}, lookups: ${JSON.stringify(lookups)}, actions: ${JSON.stringify(delegationRun.nodeResults.supervisor?.outputs?.actions ?? []).slice(0, 600)})`
    );
    console.log("OK 3/3 sub-agent      →", delegated.trim());
    console.log(`live model: ${PROVIDER}/${MODEL_ID}`);
  } finally {
    await app.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("FAILED", error?.message ?? error);
    process.exit(1);
  }
);
