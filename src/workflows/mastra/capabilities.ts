/**
 * @module as-graph/workflows/mastra/capabilities
 * @summary Capability coverage matrix for the Mastra fixture set
 * (SAA-1545 §5.2).
 * @description Accounts for every `MASTRA_FEATURE_CAPABILITIES` row with either
 * a focused graph fixture or an explicit deterministic conformance scenario.
 * Unsupported rows stay visible with their fail-closed behaviour and reason;
 * no row is omitted or implied by a neighbouring fixture.
 */
import {
  MASTRA_FEATURE_CAPABILITIES,
  type MastraFeatureVerdict,
} from "../../mastra/MastraCapabilities";

/** The kind of evidence a capability row resolves to. */
export type MastraCapabilityEvidenceKind =
  | "graph-workflow"
  | "deterministic-scenario";

/**
 * A deterministic conformance scenario for a capability that is a host
 * service, management/read surface, or intentionally unsupported behaviour.
 */
export interface MastraConformanceScenario {
  /** Stable scenario id. */
  id: string;
  /** The capability rows the scenario covers. */
  capabilities: string[];
  /** The evidence kind. */
  kind: MastraCapabilityEvidenceKind;
  /** The expected observable behaviour. */
  expectedBehavior: string;
  /** The stable graph error code when the capability fails closed. */
  expectedGraphCode?: string;
  /** Why the capability is scenario-only rather than a graph fixture. */
  reason: string;
}

/** Every deterministic conformance scenario, keyed by stable id. */
export const MASTRA_CONFORMANCE_SCENARIOS: readonly MastraConformanceScenario[] =
  [
    {
      id: "scenario-canonical-document-builder",
      capabilities: ["builders"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "The emitted canonical GraphWorkflowDocument round-trips through the serializer and compiles without executable functions.",
      reason:
        "The builder surface is authoring-time API, not a node behaviour; every fixture is its concrete output.",
    },
    {
      id: "scenario-code-mode-fail-closed",
      capabilities: ["codeModeConditions"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "A code-mode condition fails closed instead of running unsandboxed code.",
      expectedGraphCode: "GRAPH_CODE_MODE_UNSUPPORTED_BACKEND",
      reason:
        "The Mastra backend declares codeMode unsupported; reuse of the local sandbox is an explicit host extension point.",
    },
    {
      id: "scenario-edge-state-events",
      capabilities: ["edgeStateEvents"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "Edge values are routed by graph port identity and emitted as observable edge events.",
      reason:
        "Routing is exercised by every fixture; the dedicated assertion is the deterministic event recorder.",
    },
    {
      id: "scenario-suspend-resume",
      capabilities: ["suspendResume", "humanInTheLoop", "humanApproval"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "The HITL node suspends, then resumes with the validated payload and emits one approved/rejected branch.",
      reason:
        "Resume requires a host suspend-state reader; the focused HITL fixture covers the graph half and this scenario the resume half.",
    },
    {
      id: "scenario-pinning-fail-closed",
      capabilities: ["pinning"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "A pinning request fails closed with an explicit not-supported result; no value adapter is fabricated.",
      reason: "Mastra declares pinning NOT-SUPPORTED.",
    },
    {
      id: "scenario-error-boundary-partial",
      capabilities: ["errorBoundary"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "The error boundary catches the declared try body failure and reports the partial-support limitation.",
      reason:
        "Mastra declares errorBoundary PARTIAL; the basic registry carries the full reference fixture.",
    },
    {
      id: "scenario-runtime-engine-loading",
      capabilities: ["runtimeEngineLoading"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "Local boot loads zero @mastra modules; Mastra boot loads the Mastra registry only.",
      reason: "Cross-engine isolation is a boot-time assertion, not a workflow.",
    },
    {
      id: "scenario-dynamic-topology-fail-closed",
      capabilities: ["dynamicTopology"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "A changed document fingerprint is rejected rather than transparently recompiled.",
      reason: "Mastra declares dynamicTopology NOT-SUPPORTED.",
    },
    {
      id: "scenario-durable-execution",
      capabilities: ["durableExecution"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "A run survives a runtime restart through the host-declared durable storage domain.",
      reason: "Durability is a host storage contract; the default fixture suite uses deterministic fakes.",
    },
    {
      id: "scenario-ai-step-surfaces",
      capabilities: ["aiStepSurfaces"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "Node metadata exposes the projected read-only AI step surface without shared type changes.",
      reason: "The surface is projected catalogue metadata, not executable graph behaviour.",
    },
    {
      id: "scenario-observability",
      capabilities: ["engineObservability", "ourNodeObservabilityIsolation"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "Every node emits a decafNode-origin signal through the observability bridge, separated from engine-internal signals.",
      reason: "Observability is an event-record assertion over a run.",
    },
    {
      id: "scenario-layered-persistence",
      capabilities: ["layeredPersistence"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "Replays, cache, and pins route to their configured layers and a fingerprint change invalidates the cache.",
      reason: "Persistence routing is a host adapter contract.",
    },
    {
      id: "scenario-runs-snapshots-observables",
      capabilities: ["runsSnapshotsObservables"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "Runs expose snapshots and observables with terminal status and replayable events.",
      reason: "Run lifecycle is verified through the run/event recorder.",
    },
    {
      id: "scenario-workflow-management",
      capabilities: [
        "workflowList",
        "workflowLookup",
        "workflowCreate",
        "workflowUpdate",
        "workflowDelete",
        "workflowRegistryList",
        "workflowRegistryLookup",
        "workflowSerialize",
      ],
      kind: "deterministic-scenario",
      expectedBehavior:
        "Real addWorkflow/removeWorkflow/listWorkflows/getWorkflow operations drive the registered workflow catalogue.",
      reason: "Workflow management is a backend API surface, not a graph node.",
    },
    {
      id: "scenario-workflow-persist-fail-closed",
      capabilities: ["workflowPersist"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "Workflow persistence is reported NOT-SUPPORTED with a stable typed result.",
      expectedGraphCode: "GRAPH_MASTRA_PERSIST_NOT_SUPPORTED",
      reason:
        "Mastra declares workflowPersist NOT-SUPPORTED; only agent/tool-referenced steps persist natively.",
    },
    {
      id: "scenario-workflow-version",
      capabilities: ["workflowVersion"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "The wrapper tracks the canonical document fingerprint because Mastra has no native workflow version.",
      reason: "Workflow version is an extension point.",
    },
    {
      id: "scenario-metrics-read",
      capabilities: ["metricsRuns", "metricsScores", "metricsTraces"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "Read-only run/score/trace metrics resolve from the host-provided Mastra storage and fail closed when a domain is absent.",
      expectedGraphCode: "GRAPH_MASTRA_METRICS_UNAVAILABLE",
      reason: "Metrics are read surfaces over host storage.",
    },
    {
      id: "scenario-mcp-host-surface",
      capabilities: ["mcpServerTrigger"],
      kind: "deterministic-scenario",
      expectedBehavior:
        "The MCP trigger fails closed without the host server factory and succeeds with the deterministic fake.",
      expectedGraphCode: "GRAPH_MASTRA_MCP_UNAVAILABLE",
      reason: "@mastra/mcp is host-supplied; the focused trigger fixture covers the graph half.",
    },
    {
      id: "scenario-schedule-trigger",
      capabilities: ["scheduleTrigger"],
      kind: "graph-workflow",
      expectedBehavior:
        "The engine-neutral schedule-to-code fixture compiles on the Mastra backend with its cron validated by mastra's validateCron and registered on the scheduled workflow.",
      reason:
        "Schedule triggers are engine-neutral core.trigger.schedule nodes; the basic fixture supplies the graph evidence while this scenario records the Mastra compile-time cron contract.",
    },
  ];

/**
 * The per-kind and composite fixture ids that evidence each capability row.
 * Rows with no entry here must be covered by a `MastraConformanceScenario`.
 */
export const MASTRA_CAPABILITY_FIXTURES: Record<string, readonly string[]> = {
  declarativeDocument: [
    "fixture-chat-agent",
    "fixture-mastra-parallel-fanout",
  ],
  nodeExecutorByKind: [
    "fixture-mastra-parallel-fanout",
    "fixture-mastra-agent-wiring",
  ],
  graphicalConditions: ["fixture-mastra-branch"],
  whileUntil: ["fixture-mastra-loop"],
  foreach: ["fixture-mastra-loop"],
  parallel: ["fixture-mastra-parallel-fanout"],
  parametersStateBindings: ["fixture-mastra-parallel-fanout"],
  agentLlmNode: ["fixture-mastra-agent", "fixture-mastra-agent-wiring"],
  embeddings: ["fixture-mastra-embedding", "fixture-mastra-agent-wiring"],
  vectorStores: ["fixture-mastra-vectorStore", "fixture-mastra-rag"],
  memoryStorage: ["fixture-mastra-memory", "fixture-mastra-agent-wiring"],
  processorVariants: [
    "fixture-mastra-inputProcessor",
    "fixture-mastra-outputProcessor",
  ],
  ragChains: [
    "fixture-mastra-chain-qa",
    "fixture-mastra-chain-basic",
    "fixture-mastra-chain-summarization",
    "fixture-mastra-rag",
  ],
  inputProcessors: [
    "fixture-mastra-inputProcessor",
    "fixture-mastra-agent-wiring",
  ],
  outputProcessors: [
    "fixture-mastra-outputProcessor",
    "fixture-mastra-agent-wiring",
  ],
  guardrails: ["fixture-mastra-guardrail", "fixture-mastra-agent-wiring"],
  humanInTheLoop: ["fixture-mastra-hitl", "fixture-mastra-hitl-resume"],
  scheduleTrigger: ["fixture-schedule-code"],
  channelTriggers: [
    "fixture-mastra-trigger-slack",
    "fixture-mastra-trigger-discord",
    "fixture-mastra-trigger-telegram",
    "fixture-mastra-trigger-teams",
    "fixture-mastra-triggers-responses",
  ],
  channelResponses: [
    "fixture-mastra-response-slack",
    "fixture-mastra-response-discord",
    "fixture-mastra-response-telegram",
    "fixture-mastra-response-teams",
    "fixture-mastra-triggers-responses",
  ],
  voice: ["fixture-mastra-voice"],
  agentToolBuilders: [
    "fixture-mastra-tool",
    "fixture-mastra-toolSelector",
    "fixture-mastra-skill",
    "fixture-mastra-scorer",
    "fixture-mastra-agent-wiring",
  ],
};

/**
 * One capability row of the coverage matrix, resolved for the Mastra fixture
 * set.
 */
export interface MastraCapabilityCoverageRow {
  /** The `MASTRA_FEATURE_CAPABILITIES` feature row this entry accounts for. */
  feature: string;
  /** The declared capability verdict for that row. */
  verdict: MastraFeatureVerdict;
  /** Fixture ids that exercise the row. */
  fixtureIds: readonly string[];
  /** Deterministic conformance scenario ids that evidence the row. */
  scenarioIds: readonly string[];
  /** Whether at least one fixture or scenario is linked to the row. */
  covered: boolean;
  /** Why the row has no linked evidence, when it is uncovered. */
  reason?: string;
}

/**
 * Builds the capability coverage matrix: one entry per capability row, with its
 * graph fixtures and/or deterministic scenario. A row with neither is reported
 * as uncovered.
 *
 * @returns The complete matrix, in `MASTRA_FEATURE_CAPABILITIES` order.
 */
export function buildMastraCapabilityCoverage(): MastraCapabilityCoverageRow[] {
  return MASTRA_FEATURE_CAPABILITIES.map((row) => {
    const fixtureIds = MASTRA_CAPABILITY_FIXTURES[row.feature] ?? [];
    const scenarioIds = MASTRA_CONFORMANCE_SCENARIOS.filter((scenario) =>
      scenario.capabilities.includes(row.feature)
    ).map((scenario) => scenario.id);
    return {
      feature: row.feature,
      verdict: row.verdict,
      fixtureIds,
      scenarioIds,
      covered: fixtureIds.length > 0 || scenarioIds.length > 0,
      ...(fixtureIds.length === 0 && scenarioIds.length === 0
        ? { reason: "No fixture or deterministic scenario linked to this row." }
        : {}),
    };
  });
}

/**
 * Lists capability rows with no linked fixture or deterministic scenario.
 *
 * @returns The uncovered feature names (empty when the matrix is complete).
 */
export function uncoveredMastraCapabilities(): string[] {
  return buildMastraCapabilityCoverage()
    .filter((row) => !row.covered)
    .map((row) => row.feature);
}
