/**
 * @module as-graph/workflows/mastra/kind-fixtures
 * @summary One focused Mastra workflow per Mastra-owned node kind
 * (SAA-1545 §5.1–§5.2).
 * @description Each fixture is a canonical `GraphWorkflowDocument` with a
 * single explicit target kind plus the workflow boundary ports that feed the
 * kind's declared inputs and expose its declared outputs. The fixtures are
 * JSON-safe: host services are named in metadata, never embedded as functions.
 */
import type { GraphJsonValue } from "../../shared/graph";
import type { GraphNodeInstance } from "../../shared/graph/document/GraphNodeInstance";
import { MASTRA_NODE_MANIFESTS_BY_KIND } from "../../mastra/nodes/manifests";
import { document, edge, node, port } from "../builders";
import type { GraphFixtureExpectedStatus, GraphWorkflowFixture } from "../types";

/**
 * Host-service keys a fixture may require from the deterministic host fake
 * ({@link createDeterministicMastraHost}). They name backend-config callbacks
 * and stay JSON-safe in fixture metadata.
 */
export type MastraFixtureHostService =
  | "agent"
  | "rag"
  | "channel"
  | "voice"
  | "mcp"
  | "hitl"
  | "createAgent"
  | "createMemory"
  | "createMcpServer"
  | "resolveChannelAdapter"
  | "sendChannelResponse"
  | "resolveVoice"
  | "embedText"
  | "generateText"
  | "rerankDocuments"
  | "runSandboxedCode"
  | "model"
  | "storage";

/** The declared spec of one per-kind fixture. */
export interface MastraKindFixtureSpec {
  /** The Mastra-owned node kind the fixture targets. */
  kind: string;
  /** Node parameters written into the document. */
  parameters?: Record<string, GraphJsonValue>;
  /** Host services the fixture needs. */
  hostServices?: MastraFixtureHostService[];
  /** Capability rows the fixture demonstrates. */
  capabilities?: string[];
  /** Expected terminal status; defaults to `succeeded`. */
  expectedStatus?: GraphFixtureExpectedStatus;
  /** Expected stable graph error code for a fail-closed fixture. */
  expectedGraphCode?: string;
  /** Node parameter carrying the required `resumeSchema` when present. */
  resumeSchema?: GraphJsonValue;
}

/** Slugs the kind into a stable fixture id. */
function fixtureIdOf(kind: string): string {
  return `fixture-mastra-${kind
    .replace(/^core\.agent\.?/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "agent"}`;
}

/**
 * Returns a deterministic, schema-shaped workflow input value for one port.
 *
 * @param portId - The node input port id.
 * @returns The JSON-safe default value.
 */
function inputValueFor(portId: string): GraphJsonValue {
  if (/amount|size|count|topk|topn|iterations|timeout|max|dimension|score/i.test(portId)) {
    return 4;
  }
  if (/documents|chunks|values|tools|skills|scorers|memories/i.test(portId)) {
    return ["alpha", "beta"];
  }
  if (/approved|strict|hasdefault|enabled|semantic/i.test(portId)) {
    return true;
  }
  if (/options|filter|schema|structuredoutput|resumeschema|embedding|connection/i.test(portId)) {
    return {};
  }
  return `${portId}-value`;
}

/**
 * Builds the focused document for one Mastra kind from its manifest.
 *
 * @param spec - The fixture spec.
 * @returns The canonical workflow document.
 */
function buildKindDocument(spec: MastraKindFixtureSpec): {
  document: ReturnType<typeof document>;
  inputs: Record<string, GraphJsonValue>;
} {
  const manifest = MASTRA_NODE_MANIFESTS_BY_KIND[spec.kind];
  if (!manifest) {
    throw new Error(`No Mastra manifest registered for kind '${spec.kind}'`);
  }
  const parameters: Record<string, GraphJsonValue> = {
    ...(spec.parameters ?? {}),
    // The HITL step handler reads the resume schema from the node parameters,
    // not the workflow input; carry it on both surfaces so the node compiles
    // and the documented boundary input still exists.
    ...(spec.resumeSchema !== undefined
      ? { resumeSchema: spec.resumeSchema }
      : {}),
  };
  const inputs: Record<string, GraphJsonValue> = {};
  const workflowInputs = manifest.inputs.map((inputPort) => {
    const id = `in-${inputPort.id}`;
    inputs[id] =
      inputPort.id === "resumeSchema" && spec.resumeSchema !== undefined
        ? spec.resumeSchema
        : inputValueFor(inputPort.id);
    return port(id, {
      label: `${inputPort.label} (${spec.kind})`,
      ...(inputPort.schema ? { schema: inputPort.schema } : {}),
      ...(inputPort.required ? { required: true } : {}),
    });
  });
  const workflowOutputs = manifest.outputs.map((outputPort) =>
    port(`out-${outputPort.id}`, {
      label: `${outputPort.label} (${spec.kind})`,
      ...(outputPort.schema ? { schema: outputPort.schema } : {}),
    })
  );
  const nodeInstance: GraphNodeInstance = node("target", spec.kind, parameters);
  return {
    document: document({
      id: fixtureIdOf(spec.kind),
      name: fixtureIdOf(spec.kind),
      inputs: workflowInputs,
      outputs: workflowOutputs,
      nodes: [nodeInstance],
      edges: [
        ...manifest.inputs.map((inputPort) =>
          edge(`e-in-${inputPort.id}`, ["workflow", `in-${inputPort.id}`], [
            "node",
            "target",
            inputPort.id,
          ])
        ),
        ...manifest.outputs.map((outputPort) =>
          edge(`e-out-${outputPort.id}`, ["node", "target", outputPort.id], [
            "workflow",
            `out-${outputPort.id}`,
          ])
        ),
      ],
    }),
    inputs,
  };
}

/**
 * Builds the per-kind fixture from its spec.
 *
 * @param spec - The fixture spec.
 * @returns The executable Mastra fixture.
 */
function buildKindFixture(spec: MastraKindFixtureSpec): GraphWorkflowFixture {
  const built = buildKindDocument(spec);
  const expectedStatus = spec.expectedStatus ?? "succeeded";
  return {
    id: built.document.id,
    document: built.document,
    kinds: [spec.kind],
    targetKinds: [spec.kind],
    combos: ["exposed-ports", "defaults"],
    family: "mastra",
    engine: "mastra",
    capabilities: spec.capabilities ?? ["nodeExecutorByKind"],
    requiredHostServices: spec.hostServices ?? [],
    executable: true,
    inputs: built.inputs,
    expectedOutputs: {},
    expectations: {
      mastra: {
        executable: true,
        expectedStatus,
        ...(spec.expectedGraphCode
          ? { expectedGraphCode: spec.expectedGraphCode }
          : {}),
        expectedSucceededNodeIds:
          expectedStatus === "succeeded" ? ["target"] : [],
      },
      local: {
        executable: false,
        skipReason:
          "Mastra-owned node kind; the local/general engine fails closed with GRAPH_LOCAL_UNSUPPORTED_NODE_KIND.",
      },
    },
  };
}

/**
 * The per-kind specs, one entry per Mastra-owned kind. The fixture document,
 * boundary ports, and expected status are derived from the kind's manifest and
 * these overrides.
 */
export const MASTRA_KIND_FIXTURE_SPECS: readonly MastraKindFixtureSpec[] = [
  { kind: "core.agent", hostServices: ["agent", "createAgent"], capabilities: ["agentLlmNode", "agentToolBuilders"] },
  { kind: "core.agent.tool", capabilities: ["agentToolBuilders"] },
  { kind: "core.agent.toolSelector", capabilities: ["agentToolBuilders"] },
  { kind: "core.agent.hook", capabilities: ["agentToolBuilders"] },
  { kind: "core.agent.toolDeny", capabilities: ["agentToolBuilders"] },
  { kind: "core.agent.delegationHook", capabilities: ["agentToolBuilders"] },
  { kind: "core.agent.skill", capabilities: ["agentToolBuilders"] },
  { kind: "core.agent.skillSelector", capabilities: ["agentToolBuilders"] },
  { kind: "core.agent.sandbox", hostServices: ["rag"], capabilities: ["agentToolBuilders", "aiStepSurfaces"] },
  { kind: "core.agent.scorer", capabilities: ["agentToolBuilders"] },
  { kind: "core.agent.scorerSelector", capabilities: ["agentToolBuilders"] },
  { kind: "core.agent.memory", hostServices: ["createMemory"], capabilities: ["memoryStorage"] },
  { kind: "core.agent.memorySelector", hostServices: ["createMemory"], capabilities: ["memoryStorage"] },
  { kind: "core.agent.embedding", hostServices: ["rag", "embedText"], capabilities: ["embeddings"] },
  { kind: "core.agent.vectorStore", hostServices: ["rag"], capabilities: ["vectorStores"] },
  { kind: "core.agent.retriever", hostServices: ["rag"], capabilities: ["vectorStores", "ragChains"] },
  { kind: "core.agent.chunking", hostServices: ["rag"], capabilities: ["ragChains"] },
  { kind: "core.agent.rerank", hostServices: ["rag", "rerankDocuments"], capabilities: ["ragChains"] },
  { kind: "core.agent.chain.qa", hostServices: ["rag", "generateText"], capabilities: ["ragChains"] },
  { kind: "core.agent.chain.basic", hostServices: ["rag", "generateText"], capabilities: ["ragChains"] },
  { kind: "core.agent.chain.summarization", hostServices: ["rag", "generateText"], capabilities: ["ragChains"] },
  { kind: "core.agent.structuredOutputParser", hostServices: ["rag"], capabilities: ["ragChains", "aiStepSurfaces"] },
  { kind: "core.agent.informationExtractor", hostServices: ["rag", "generateText"], capabilities: ["ragChains"] },
  { kind: "core.agent.langchainCode", hostServices: ["rag", "runSandboxedCode"], capabilities: ["aiStepSurfaces"] },
  { kind: "core.agent.inputProcessor", capabilities: ["inputProcessors", "processorVariants"] },
  { kind: "core.agent.outputProcessor", capabilities: ["outputProcessors", "processorVariants"] },
  { kind: "core.agent.guardrail", capabilities: ["guardrails"] },
  {
    kind: "core.agent.hitl",
    expectedStatus: "suspended",
    resumeSchema: {
      type: "object",
      properties: { approved: { type: "boolean" } },
    },
    capabilities: ["humanInTheLoop", "suspendResume", "humanApproval"],
  },
  { kind: "core.agent.trigger.mcp", hostServices: ["mcp", "createMcpServer"], capabilities: ["mcpServerTrigger"] },
  { kind: "core.agent.trigger.slack", hostServices: ["channel", "resolveChannelAdapter"], capabilities: ["channelTriggers"] },
  { kind: "core.agent.trigger.discord", hostServices: ["channel", "resolveChannelAdapter"], capabilities: ["channelTriggers"] },
  { kind: "core.agent.trigger.telegram", hostServices: ["channel", "resolveChannelAdapter"], capabilities: ["channelTriggers"] },
  { kind: "core.agent.trigger.teams", hostServices: ["channel", "resolveChannelAdapter"], capabilities: ["channelTriggers"] },
  { kind: "core.agent.response.slack", hostServices: ["channel", "sendChannelResponse"], capabilities: ["channelResponses"] },
  { kind: "core.agent.response.discord", hostServices: ["channel", "sendChannelResponse"], capabilities: ["channelResponses"] },
  { kind: "core.agent.response.telegram", hostServices: ["channel", "sendChannelResponse"], capabilities: ["channelResponses"] },
  { kind: "core.agent.response.teams", hostServices: ["channel", "sendChannelResponse"], capabilities: ["channelResponses"] },
  { kind: "core.agent.voice", hostServices: ["voice", "resolveVoice"], capabilities: ["voice"] },
];

/** One focused workflow per Mastra-owned node kind. */
export const mastraKindFixtures: GraphWorkflowFixture[] =
  MASTRA_KIND_FIXTURE_SPECS.map(buildKindFixture);

/** The per-kind fixtures keyed by their single target kind. */
export const mastraKindFixturesByKind: Record<string, GraphWorkflowFixture> =
  Object.fromEntries(
    mastraKindFixtures.map((fixture) => [fixture.targetKinds![0], fixture])
  );
