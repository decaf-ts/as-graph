/**
 * @module as-graph/workflows/mastra/composites
 * @summary Focused composite Mastra workflows for behaviour one node cannot
 * demonstrate alone (SAA-1545 §5.2).
 * @description Each fixture targets a named behaviour (parallel fan-out/fan-in,
 * branch/loop, structured output, RAG, HITL resume, triggers/responses, voice,
 * agent-zone wiring) and names the `MASTRA_FEATURE_CAPABILITIES` rows it
 * demonstrates. Host services are metadata only; the deterministic fake host
 * supplies them at execution time.
 */
import type { GraphJsonValue } from "../../shared/graph";
import { document, edge, node, port } from "../builders";
import type { GraphWorkflowFixture, GraphConfigCombo } from "../types";

/** The feature rows every composite also demonstrates. */
const COMPOSITE_BASE_CAPABILITIES = [
  "declarativeDocument",
  "nodeExecutorByKind",
];

/**
 * Builds a mastra composite fixture with the shared registry metadata.
 *
 * @param input - The fixture fields.
 * @returns The normalised mastra fixture.
 */
function composite(input: {
  id: string;
  document: ReturnType<typeof document>;
  kinds: string[];
  targetKinds: string[];
  capabilities?: string[];
  requiredHostServices?: string[];
  inputs?: Record<string, GraphJsonValue>;
  expectedStatus?: "succeeded" | "failed" | "suspended";
  expectedGraphCode?: string;
  expectedSucceededNodeIds?: string[];
  combos?: GraphConfigCombo[];
  scenario?: string;
}): GraphWorkflowFixture {
  const expectedStatus = input.expectedStatus ?? "succeeded";
  return {
    id: input.id,
    document: input.document,
    kinds: input.kinds,
    targetKinds: input.targetKinds,
    combos: input.combos ?? ["exposed-ports", "defaults"],
    family: "mastra",
    engine: "mastra",
    capabilities: [...COMPOSITE_BASE_CAPABILITIES, ...(input.capabilities ?? [])],
    requiredHostServices: input.requiredHostServices ?? [],
    ...(input.scenario ? { scenario: input.scenario } : {}),
    executable: true,
    inputs: input.inputs ?? {},
    expectedOutputs: {},
    expectations: {
      mastra: {
        executable: true,
        expectedStatus,
        ...(input.expectedGraphCode
          ? { expectedGraphCode: input.expectedGraphCode }
          : {}),
        expectedSucceededNodeIds: input.expectedSucceededNodeIds ?? [],
      },
      local: {
        executable: false,
        skipReason:
          "Mastra capability fixture; local boot seeds the basic registry only.",
      },
    },
  };
}

/** Two independent map peers joined by a single downstream consumer. */
export const parallelFanoutDocument = document({
  id: "fixture-mastra-parallel-fanout",
  name: "fixture-mastra-parallel-fanout",
  inputs: [port("left", { required: true }), port("right", { required: true })],
  outputs: [port("answer")],
  nodes: [
    node("leftMap", "core.utility.map"),
    node("rightMap", "core.utility.map"),
    node("join", "core.agent.chain.qa"),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["workflow", "left"], ["node", "leftMap", "value"]),
    edge("e2", ["workflow", "right"], ["node", "rightMap", "value"]),
    edge("e3", ["node", "leftMap", "result"], ["node", "join", "context"]),
    edge("e4", ["node", "rightMap", "result"], ["node", "join", "query"]),
    edge("e5", ["node", "join", "text"], ["node", "sink", "value"]),
    edge("e6", ["node", "join", "text"], ["workflow", "answer"]),
  ],
});

/** A branch selecting one of two independent arms. */
export const branchDocument = document({
  id: "fixture-mastra-branch",
  name: "fixture-mastra-branch",
  inputs: [port("n", { required: true })],
  outputs: [port("thenValue"), port("elseValue")],
  nodes: [
    node(
      "branch",
      "core.flow.if",
      { else: true },
      {
        metadata: {
          condition: { op: "gte", left: { path: "value" }, right: { const: 1 } },
        },
      }
    ),
    node("thenMap", "core.utility.map"),
    node("elseMap", "core.utility.map"),
  ],
  edges: [
    edge("e1", ["workflow", "n"], ["node", "branch", "value"]),
    edge("e2", ["node", "branch", "then"], ["node", "thenMap", "value"]),
    edge("e3", ["node", "branch", "else"], ["node", "elseMap", "value"]),
    edge("e4", ["node", "thenMap", "result"], ["workflow", "thenValue"]),
    edge("e5", ["node", "elseMap", "result"], ["workflow", "elseValue"]),
  ],
});

const loopBody = document({
  id: "fixture-mastra-loop-body",
  name: "fixture-mastra-loop-body",
  inputs: [port("item")],
  outputs: [port("result")],
  nodes: [node("map", "core.utility.map")],
  edges: [
    edge("b1", ["workflow", "item"], ["node", "map", "value"]),
    edge("b2", ["node", "map", "result"], ["workflow", "result"]),
  ],
});

/** A foreach loop compiling its body through the same compiler. */
export const loopDocument = document({
  id: "fixture-mastra-loop",
  name: "fixture-mastra-loop",
  inputs: [port("items", { required: true })],
  outputs: [port("collected")],
  nodes: [
    node(
      "loop",
      "core.loop.foreach",
      { itemPort: "item", resultPort: "result", maxIterations: 5 },
      { loop: { body: loopBody } }
    ),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["workflow", "items"], ["node", "loop", "items"]),
    edge("e2", ["node", "loop", "completed"], ["node", "sink", "value"]),
    edge("e3", ["node", "loop", "completed"], ["workflow", "collected"]),
  ],
});

const STRUCTURED_OUTPUT: GraphJsonValue = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

const EXTRACTOR_STRUCTURED_OUTPUT: GraphJsonValue = {
  type: "object",
  properties: { subject: { type: "string" } },
};

/** Structured output through the extractor → parser chain. */
export const structuredOutputDocument = document({
  id: "fixture-mastra-structured-output",
  name: "fixture-mastra-structured-output",
  inputs: [port("text", { required: true })],
  outputs: [port("object")],
  nodes: [
    node("extractor", "core.agent.informationExtractor", {
      structuredOutput: EXTRACTOR_STRUCTURED_OUTPUT,
    }),
    node("parser", "core.agent.structuredOutputParser", {
      structuredOutput: STRUCTURED_OUTPUT,
    }),
  ],
  edges: [
    edge("e1", ["workflow", "text"], ["node", "extractor", "text"]),
    edge("e2", ["node", "extractor", "data"], ["node", "parser", "text"]),
    edge("e3", ["node", "parser", "object"], ["workflow", "object"]),
  ],
});

/** A RAG chain: chunking → rerank → QA chain. */
export const ragDocument = document({
  id: "fixture-mastra-rag",
  name: "fixture-mastra-rag",
  inputs: [port("text", { required: true }), port("query", { required: true })],
  outputs: [port("answer")],
  nodes: [
    node("chunker", "core.agent.chunking"),
    node("reranker", "core.agent.rerank"),
    node("chain", "core.agent.chain.qa"),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["workflow", "text"], ["node", "chunker", "separator"]),
    edge("e2", ["node", "chunker", "chunks"], ["node", "reranker", "documents"]),
    edge("e3", ["workflow", "query"], ["node", "reranker", "query"]),
    edge("e4", ["node", "reranker", "documents"], ["node", "chain", "context"]),
    edge("e5", ["workflow", "query"], ["node", "chain", "query"]),
    edge("e6", ["node", "chain", "text"], ["node", "sink", "value"]),
    edge("e7", ["node", "chain", "text"], ["workflow", "answer"]),
  ],
});

const HITL_RESUME_SCHEMA: GraphJsonValue = {
  type: "object",
  properties: { approved: { type: "boolean" }, value: { type: "string" } },
};

/** HITL suspend → resume composite. */
export const hitlResumeDocument = document({
  id: "fixture-mastra-hitl-resume",
  name: "fixture-mastra-hitl-resume",
  inputs: [port("value", { required: true }), port("resumeSchema", { required: true })],
  outputs: [port("approved"), port("rejected")],
  nodes: [
    node("approval", "core.agent.hitl", {
      message: "Approve the workflow?",
      resumeSchema: HITL_RESUME_SCHEMA,
    }),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["workflow", "value"], ["node", "approval", "value"]),
    edge("e2", ["workflow", "resumeSchema"], ["node", "approval", "resumeSchema"]),
    edge("e3", ["node", "approval", "approved"], ["node", "sink", "value"]),
    edge("e4", ["node", "approval", "approved"], ["workflow", "approved"]),
    edge("e5", ["node", "approval", "rejected"], ["workflow", "rejected"]),
  ],
});

/** Channel trigger → response composite. */
export const triggersResponsesDocument = document({
  id: "fixture-mastra-triggers-responses",
  name: "fixture-mastra-triggers-responses",
  inputs: [],
  outputs: [port("message"), port("delivered")],
  nodes: [
    node("trigger", "core.agent.trigger.slack"),
    node("response", "core.agent.response.slack"),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["node", "trigger", "message"], ["node", "response", "response"]),
    edge("e2", ["node", "trigger", "threadId"], ["node", "response", "threadId"]),
    edge("e3", ["node", "trigger", "message"], ["workflow", "message"]),
    edge("e4", ["node", "response", "resource"], ["workflow", "delivered"]),
    edge("e5", ["node", "response", "resource"], ["node", "sink", "value"]),
  ],
});

/** Voice node composite. */
export const voiceDocument = document({
  id: "fixture-mastra-voice-composite",
  name: "fixture-mastra-voice-composite",
  inputs: [port("speaker", { required: true })],
  outputs: [port("voice")],
  nodes: [node("voice", "core.agent.voice"), node("sink", "result")],
  edges: [
    edge("e1", ["workflow", "speaker"], ["node", "voice", "speaker"]),
    edge("e2", ["node", "voice", "resource"], ["node", "sink", "value"]),
    edge("e3", ["node", "voice", "resource"], ["workflow", "voice"]),
  ],
});

const WIRING_TRIGGER_DOCUMENT = document({
  id: "fixture-mastra-agent-wiring-trigger",
  name: "fixture-mastra-agent-wiring-trigger",
  outputs: [port("payload")],
  nodes: [node("trigger", "core.trigger.manual")],
  edges: [edge("t1", ["node", "trigger", "payload"], ["workflow", "payload"])],
});

/** Agent-zone wiring: every supplier connected to one focused agent. */
export const agentWiringDocument = document({
  id: "fixture-mastra-agent-wiring",
  name: "fixture-mastra-agent-wiring",
  inputs: [
    port("prompt", { required: true }),
    port("provider"),
    port("modelAdapter"),
    port("skillName", { required: true }),
    port("scorerId", { required: true }),
    port("hookValue", { required: true }),
    port("inputProcessorType", { required: true }),
    port("outputProcessorType", { required: true }),
    port("guardrailType", { required: true }),
  ],
  outputs: [port("response"), port("actions")],
  nodes: [
    node("tool", "core.agent.tool", { toolId: "weather" }),
    node("toolSelector", "core.agent.toolSelector", { tools: ["weather"] }),
    node("skill", "core.agent.skill", { name: "research" }),
    node("skillSelector", "core.agent.skillSelector", { skills: ["research"] }),
    node("scorer", "core.agent.scorer", { scorerId: "relevance" }),
    node("scorerSelector", "core.agent.scorerSelector", {
      scorers: ["relevance"],
    }),
    node("memory", "core.agent.memory", { provider: "memory", threadId: "thread-1" }),
    node("embedding", "core.agent.embedding"),
    node("sandbox", "core.agent.sandbox"),
    node("hook", "core.agent.hook", { phase: "before" }),
    node("inputProcessor", "core.agent.inputProcessor", {
      processorType: "tokenCostControl",
      options: { maxCost: 1 },
    }),
    node("outputProcessor", "core.agent.outputProcessor", {
      processorType: "batchParts",
    }),
    node("guardrail", "core.agent.guardrail", {
      guardrailType: "regexFilter",
      options: {
        rules: [{ pattern: "secret", flags: "i" }],
        strategy: "block",
      },
    }),
    node("agent", "core.agent"),
  ],
  edges: [
    edge("e1", ["workflow", "prompt"], ["node", "agent", "prompt"]),
    edge("e2", ["workflow", "provider"], ["node", "memory", "provider"]),
    edge("e3", ["workflow", "modelAdapter"], ["node", "embedding", "modelAdapter"]),
    edge("e4", ["workflow", "skillName"], ["node", "skill", "name"]),
    edge("e5", ["workflow", "scorerId"], ["node", "scorer", "scorerId"]),
    edge("e6", ["workflow", "hookValue"], ["node", "hook", "value"]),
    edge("e7", ["workflow", "inputProcessorType"], ["node", "inputProcessor", "processorType"]),
    edge("e8", ["workflow", "outputProcessorType"], ["node", "outputProcessor", "processorType"]),
    edge("e9", ["workflow", "guardrailType"], ["node", "guardrail", "guardrailType"]),
    edge("c1", ["node", "tool", "tool"], ["node", "agent", "tools"], "connection"),
    edge("c2", ["node", "toolSelector", "tool"], ["node", "agent", "tools"], "connection"),
    edge("c3", ["node", "skill", "skill"], ["node", "agent", "skill"], "connection"),
    edge("c4", ["node", "skillSelector", "skill"], ["node", "agent", "skill"], "connection"),
    edge("c5", ["node", "scorer", "scorer"], ["node", "agent", "scorers"], "connection"),
    edge("c6", ["node", "scorerSelector", "scorer"], ["node", "agent", "scorers"], "connection"),
    edge("c7", ["node", "memory", "memory"], ["node", "agent", "memory"], "connection"),
    edge("c8", ["node", "embedding", "embedding"], ["node", "agent", "embedding"], "connection"),
    edge("c9", ["node", "sandbox", "sandbox"], ["node", "agent", "sandbox"], "connection"),
    edge("c10", ["node", "hook", "hook"], ["node", "agent", "hooks"], "connection"),
    edge("c11", ["node", "inputProcessor", "processors"], ["node", "agent", "inputProcessors"], "connection"),
    edge("c12", ["node", "outputProcessor", "processors"], ["node", "agent", "outputProcessors"], "connection"),
    edge("c13", ["node", "guardrail", "guardrail"], ["node", "agent", "outputProcessors"], "connection"),
    edge("e10", ["node", "agent", "response"], ["workflow", "response"]),
    edge("e11", ["node", "agent", "actions"], ["workflow", "actions"]),
  ],
  metadata: {
    harness: WIRING_TRIGGER_DOCUMENT.id,
    wiring: "agent-zone-suppliers",
  },
});

/** Every focused composite fixture. */
export const mastraCompositeFixtures: GraphWorkflowFixture[] = [
  composite({
    id: parallelFanoutDocument.id,
    document: parallelFanoutDocument,
    kinds: ["core.utility.map", "core.agent.chain.qa", "result"],
    targetKinds: ["core.agent.chain.qa"],
    capabilities: ["parallel", "ragChains", "parametersStateBindings"],
    requiredHostServices: ["rag", "generateText"],
    inputs: { left: "alpha", right: "beta" },
    expectedSucceededNodeIds: ["leftMap", "rightMap", "join", "sink"],
  }),
  composite({
    id: branchDocument.id,
    document: branchDocument,
    kinds: ["core.flow.if", "core.utility.map"],
    targetKinds: ["core.flow.if"],
    capabilities: ["graphicalConditions"],
    inputs: { n: 7 },
    expectedSucceededNodeIds: ["branch", "thenMap"],
  }),
  composite({
    id: loopDocument.id,
    document: loopDocument,
    kinds: ["core.loop.foreach", "core.utility.map", "result"],
    targetKinds: ["core.loop.foreach"],
    capabilities: ["foreach", "whileUntil"],
    inputs: { items: [1, 2, 3] },
    expectedSucceededNodeIds: ["loop", "sink"],
  }),
  composite({
    id: structuredOutputDocument.id,
    document: structuredOutputDocument,
    kinds: [
      "core.agent.informationExtractor",
      "core.agent.structuredOutputParser",
    ],
    targetKinds: ["core.agent.structuredOutputParser"],
    capabilities: ["ragChains", "aiStepSurfaces"],
    requiredHostServices: ["rag", "generateText"],
    inputs: { text: "The subject is graph workflows." },
    expectedSucceededNodeIds: ["extractor", "parser"],
  }),
  composite({
    id: ragDocument.id,
    document: ragDocument,
    kinds: [
      "core.agent.chunking",
      "core.agent.rerank",
      "core.agent.chain.qa",
      "result",
    ],
    targetKinds: ["core.agent.chain.qa"],
    capabilities: ["ragChains", "embeddings", "vectorStores"],
    requiredHostServices: ["rag", "generateText", "rerankDocuments"],
    inputs: { text: "alpha\n\nbeta", query: "alpha" },
    expectedSucceededNodeIds: ["chunker", "reranker", "chain", "sink"],
  }),
  composite({
    id: hitlResumeDocument.id,
    document: hitlResumeDocument,
    kinds: ["core.agent.hitl", "result"],
    targetKinds: ["core.agent.hitl"],
    capabilities: ["humanInTheLoop", "suspendResume", "humanApproval"],
    inputs: {
      value: "ticket-42",
      resumeSchema: HITL_RESUME_SCHEMA,
    },
    expectedStatus: "suspended",
    scenario: "hitl-resume",
  }),
  composite({
    id: triggersResponsesDocument.id,
    document: triggersResponsesDocument,
    kinds: [
      "core.agent.trigger.slack",
      "core.agent.response.slack",
      "result",
    ],
    targetKinds: ["core.agent.response.slack"],
    capabilities: ["channelTriggers", "channelResponses"],
    requiredHostServices: [
      "channel",
      "resolveChannelAdapter",
      "sendChannelResponse",
    ],
    expectedSucceededNodeIds: ["trigger", "response", "sink"],
  }),
  composite({
    id: voiceDocument.id,
    document: voiceDocument,
    kinds: ["core.agent.voice", "result"],
    targetKinds: ["core.agent.voice"],
    capabilities: ["voice"],
    requiredHostServices: ["voice", "resolveVoice"],
    inputs: { speaker: "alloy" },
    expectedSucceededNodeIds: ["voice", "sink"],
  }),
  composite({
    id: agentWiringDocument.id,
    document: agentWiringDocument,
    kinds: [
      "core.agent",
      "core.agent.tool",
      "core.agent.toolSelector",
      "core.agent.skill",
      "core.agent.skillSelector",
      "core.agent.scorer",
      "core.agent.scorerSelector",
      "core.agent.memory",
      "core.agent.embedding",
      "core.agent.sandbox",
      "core.agent.hook",
      "core.agent.inputProcessor",
      "core.agent.outputProcessor",
      "core.agent.guardrail",
    ],
    targetKinds: ["core.agent"],
    capabilities: [
      "agentLlmNode",
      "agentToolBuilders",
      "memoryStorage",
      "inputProcessors",
      "outputProcessors",
      "guardrails",
      "embeddings",
    ],
    requiredHostServices: [
      "agent",
      "createAgent",
      "createMemory",
      "rag",
      "model",
    ],
    inputs: {
      prompt: "Summarise the ticket",
      provider: "memory",
      modelAdapter: { provider: "openai", modelId: "gpt-4o-mini" },
      skillName: "research",
      scorerId: "relevance",
      hookValue: "before",
      inputProcessorType: "tokenCostControl",
      outputProcessorType: "batchParts",
      guardrailType: "tripwire",
    },
    expectedSucceededNodeIds: ["agent"],
  }),
];
