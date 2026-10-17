/**
 * @module as-graph/mastra/MastraCapabilities
 * @summary Exported Mastra capability table (SAA-196).
 * @description The Mastra wrapper declares, per feature, whether the backend
 * supports it natively, not at all, or only through an extension point. The
 * table is exported alongside the engine-agnostic
 * {@link GraphBackendCapabilities} projection (code-mode + workflow
 * listing/lookup) so hosts and servers can surface honest limitations without
 * probing the backend.
 */
import type {
  GraphBackendCapabilities,
  GraphBackendCapabilityStatus,
} from "../engine/execution/GraphExecutionBackend";

/**
 * Whether Mastra supports a feature natively, not at all, only partially, or
 * exclusively through a declared extension point.
 */
export type MastraFeatureVerdict =
  | "SUPPORTED"
  | "NOT-SUPPORTED"
  | "EXTENSION-POINT"
  | "PARTIAL";

/** A single row of the exported Mastra capability table (SAA-196). */
export interface MastraFeatureCapability {
  /** The engine feature being described. */
  feature: string;
  /** The declared Mastra verdict for the feature. */
  verdict: MastraFeatureVerdict;
  /** Human-readable detail for the verdict. */
  detail?: string;
}

/**
 * The exported Mastra capability table (SAA-196). Every row names a feature and
 * whether Mastra supports it natively, not at all, or through a declared
 * extension point. `parallel` and `pinning` are declared NOT-SUPPORTED, and
 * code-mode conditions fail closed, so the wrapper fails loudly rather than
 * silently degrading behaviour.
 */
export const MASTRA_FEATURE_CAPABILITIES: readonly MastraFeatureCapability[] = [
  {
    feature: "builders",
    verdict: "EXTENSION-POINT",
    detail: "translate the emitted canonical document",
  },
  { feature: "declarativeDocument", verdict: "SUPPORTED" },
  { feature: "nodeExecutorByKind", verdict: "SUPPORTED" },
  {
    feature: "graphicalConditions",
    verdict: "SUPPORTED",
    detail: "branch predicates delegate to as-graph evaluateConditionSync",
  },
  {
    feature: "codeModeConditions",
    verdict: "EXTENSION-POINT",
    detail: "reuse the facade CodeSandboxEvaluator; currently fails closed",
  },
  { feature: "whileUntil", verdict: "SUPPORTED" },
  { feature: "foreach", verdict: "SUPPORTED" },
  {
    feature: "parallel",
    verdict: "NOT-SUPPORTED",
    detail: "fan-out/fan-in topology is not translated by the compiler",
  },
  { feature: "parametersStateBindings", verdict: "SUPPORTED" },
  { feature: "runsSnapshotsObservables", verdict: "SUPPORTED" },
  {
    feature: "engineObservability",
    verdict: "SUPPORTED",
    detail:
      "the mastra engine's observability entrypoint catches every signal; langfuse (@mastra/langfuse) is the default and always-present export target, wired from MASTRA__OBSERVABILITY__* with gate-C credentials failing closed",
  },
  {
    feature: "ourNodeObservabilityIsolation",
    verdict: "SUPPORTED",
    detail:
      "the compiler stamps a decafNode origin onto every translated step; the OUR-node exporter scopes OUR-node signals separately from engine-internal signals in OUR observability layer",
  },
  {
    feature: "layeredPersistence",
    verdict: "SUPPORTED",
    detail:
      "gate-A-approved per-layer routing: workflows via the as-graph adapter only, replays versioned-with-restore on fs, cache ledger on ram (atomically invalidated on fingerprint change), pins adapter for host value-store wiring; host adapters override (MASTRA__PERSISTENCE__*)",
  },
  {
    feature: "edgeStateEvents",
    verdict: "EXTENSION-POINT",
    detail: "derived from the document's declared routing",
  },
  {
    feature: "suspendResume",
    verdict: "EXTENSION-POINT",
    detail:
      "Mastra native; exposed through the optional backend resume?() extension",
  },
  { feature: "humanApproval", verdict: "SUPPORTED" },
  {
    feature: "pinning",
    verdict: "NOT-SUPPORTED",
    detail: "wrapper-managed value adapter only",
  },
  { feature: "errorBoundary", verdict: "PARTIAL" },
  { feature: "agentLlmNode", verdict: "SUPPORTED" },
  {
    feature: "embeddings",
    verdict: "SUPPORTED",
    detail: "embedding model carried as agent config (R1)",
  },
  {
    feature: "vectorStores",
    verdict: "SUPPORTED",
    detail:
      "in-memory baseline native; pgvector/redis via mastra-native bindings; age/graph via custom MastraVector stores",
  },
  {
    feature: "ragChains",
    verdict: "SUPPORTED",
    detail: "qa/basic/summarization chains compile to mastra workflow steps",
  },
  {
    feature: "inputProcessors",
    verdict: "SUPPORTED",
    detail:
      "mastra's input-processing pipeline applied as per-run agent overrides (SAA-836 M5)",
  },
  {
    feature: "outputProcessors",
    verdict: "SUPPORTED",
    detail:
      "mastra's output-processing pipeline applied as per-run agent overrides (SAA-836 M5)",
  },
  {
    feature: "guardrails",
    verdict: "SUPPORTED",
    detail:
      "guardrail kinds compose with the output-processor pipeline; tripwire aborts map to FAILED",
  },
  {
    feature: "humanInTheLoop",
    verdict: "SUPPORTED",
    detail:
      "core.agent.hitl suspends/resumes via mastra's native suspend/resume step semantics",
  },
  {
    feature: "mcpServerTrigger",
    verdict: "EXTENSION-POINT",
    detail:
      "host-supplied @mastra/mcp server surface; the trigger fails closed without it",
  },
  {
    feature: "scheduleTrigger",
    verdict: "SUPPORTED",
    detail:
      "schedule trigger nodes declare mastra's native scheduled-workflow schedule (validated with mastra's own validateCron); the scheduler starts runs on each cron fire",
  },
  {
    feature: "channelTriggers",
    verdict: "EXTENSION-POINT",
    detail:
      "slack/discord/telegram/teams trigger nodes over host-supplied mastra channel adapters (the adapter catalog is metadata-only); fail closed without the host surface",
  },
  {
    feature: "channelResponses",
    verdict: "EXTENSION-POINT",
    detail:
      "matching response nodes post the reply to the same conversation binding via the host-supplied mastra channel delivery surface; fail closed without it",
  },
  {
    feature: "voice",
    verdict: "EXTENSION-POINT",
    detail:
      "voice node resolves mastra's VoiceConfig shape through a host-supplied voice surface (agent getVoice); @mastra/voice-* providers are not vendored, so it fails closed without the host factory",
  },
  {
    feature: "agentToolBuilders",
    verdict: "SUPPORTED",
    detail:
      "MastraAgentBuilder/MastraToolBuilder produce validated canonical documents for agent and tool nodes with mastra zone wiring",
  },
  {
    feature: "runtimeEngineLoading",
    verdict: "SUPPORTED",
    detail:
      "the backend host loads the mastra/dagster engine backends through runtime dynamic imports, so a consumer of one engine never loads the other",
  },
  {
    feature: "dynamicTopology",
    verdict: "NOT-SUPPORTED",
    detail: "recompile on document fingerprint change",
  },
  { feature: "durableExecution", verdict: "SUPPORTED" },
  {
    feature: "aiStepSurfaces",
    verdict: "EXTENSION-POINT",
    detail: "projected read-only via node metadata; no shared type changes",
  },
  {
    feature: "workflowList",
    verdict: "SUPPORTED",
    detail: "over the compiled-workflow cache",
  },
  {
    feature: "workflowLookup",
    verdict: "SUPPORTED",
    detail: "over the compiled-workflow cache",
  },
  {
    feature: "workflowCreate",
    verdict: "SUPPORTED",
    detail:
      "compile a canonical document and register it on the wired Mastra runtime (real addWorkflow)",
  },
  {
    feature: "workflowUpdate",
    verdict: "SUPPORTED",
    detail:
      "recompile and replace the live registration (real removeWorkflow then addWorkflow)",
  },
  {
    feature: "workflowDelete",
    verdict: "SUPPORTED",
    detail: "remove the live registration (real removeWorkflow)",
  },
  {
    feature: "workflowRegistryList",
    verdict: "SUPPORTED",
    detail: "list the registered workflows (real listWorkflows)",
  },
  {
    feature: "workflowRegistryLookup",
    verdict: "SUPPORTED",
    detail: "read a registered workflow (real getWorkflow)",
  },
  {
    feature: "workflowSerialize",
    verdict: "SUPPORTED",
    detail: "the real Workflow.serializedStepGraph of a registered workflow",
  },
  {
    feature: "workflowPersist",
    verdict: "NOT-SUPPORTED",
    detail:
      "real addDynamicWorkflow persists only agent/tool-referenced steps; the canonical translation emits host code steps",
  },
  {
    feature: "workflowVersion",
    verdict: "EXTENSION-POINT",
    detail:
      "Mastra has no native workflow version; the wrapper tracks the canonical document fingerprint",
  },
  {
    feature: "metricsRuns",
    verdict: "SUPPORTED",
    detail:
      "read-only agent run metrics over the host-provided Mastra storage; fails closed when the storage or its workflows domain is absent",
  },
  {
    feature: "metricsScores",
    verdict: "SUPPORTED",
    detail:
      "read-only per-run score metrics over the host-provided Mastra storage; fails closed when the scores domain is absent",
  },
  {
    feature: "metricsTraces",
    verdict: "SUPPORTED",
    detail:
      "read-only per-run trace spans over the host-provided Mastra observability domain; fails closed when the domain is absent",
  },
];

/**
 * The three-valued management status a Mastra workflow-management capability row
 * resolves to. Extends the engine-agnostic two-valued
 * {@link GraphBackendCapabilityStatus} with the honest `extension_point` state.
 */
export type MastraWorkflowCapabilityStatus =
  | GraphBackendCapabilityStatus
  | "extension_point";

/**
 * The Mastra workflow-management capability projection (SAA-346): the real
 * `@mastra/core` management operations the driver exposes, each resolved honestly
 * from the exported feature table.
 */
export interface MastraWorkflowManagementCapabilities {
  /** Create (register a translated canonical document) support. */
  create: MastraWorkflowCapabilityStatus;
  /** Update/edit (recompile and replace the registration) support. */
  update: MastraWorkflowCapabilityStatus;
  /** Delete (remove the registration) support. */
  delete: MastraWorkflowCapabilityStatus;
  /** Serialization (real `serializedStepGraph`) support. */
  serialize: MastraWorkflowCapabilityStatus;
  /** Persistence (real `addDynamicWorkflow`) support. */
  persist: MastraWorkflowCapabilityStatus;
  /** Native workflow versioning support. */
  version: MastraWorkflowCapabilityStatus;
}

/**
 * The Mastra metrics-read capability projection (SAA-836 S2): the read-only
 * metrics families the backend serves over the host-provided mastra storage,
 * each resolved honestly from the exported feature table.
 */
export interface MastraMetricsReadCapabilities {
  /** Agent run metrics (list/get) support. */
  runs: MastraWorkflowCapabilityStatus;
  /** Per-run score metrics support. */
  scores: MastraWorkflowCapabilityStatus;
  /** Per-run trace span metrics support. */
  traces: MastraWorkflowCapabilityStatus;
}

/**
 * The full capability projection of the Mastra backend: the engine-agnostic
 * engine surface extended with the SAA-346 workflow-management statuses and the
 * SAA-836 S2 read-only metrics families.
 */
export interface MastraBackendCapabilities extends GraphBackendCapabilities {
  /** Workflow list/lookup plus the management statuses. */
  workflows: GraphBackendCapabilities["workflows"] &
    MastraWorkflowManagementCapabilities;
  /** Read-only metrics families (SAA-836 S2). */
  metrics: MastraMetricsReadCapabilities;
}

/**
 * Resolves a feature row's three-valued management status from the exported
 * table, mapping the wrapper's `SUPPORTED`/`NOT-SUPPORTED`/`EXTENSION-POINT`
 * verdicts onto the projection's lowercase vocabulary.
 *
 * @param feature - The feature row name to resolve.
 * @returns The three-valued management status.
 */
export function mastraCapabilityStatusOf(
  feature: string
): MastraWorkflowCapabilityStatus {
  const verdict = mastraCapabilityOf(feature)?.verdict;
  if (verdict === "SUPPORTED") return "supported";
  if (verdict === "EXTENSION-POINT") return "extension_point";
  // Fail closed (C6): a missing/renamed row or a PARTIAL verdict must never
  // silently resolve to `supported`.
  return "not_supported";
}

/**
 * Engine-agnostic capability projection of the Mastra backend: no in-process
 * code execution, workflow list/lookup supported over the compiled-workflow cache,
 * and the SAA-346 workflow-management statuses resolved from the exported table.
 *
 * @returns The {@link MastraBackendCapabilities} served by the Mastra backend.
 */
export function resolveMastraCapabilities(): MastraBackendCapabilities {
  return {
    codeMode: "unsupported",
    workflows: {
      list: "supported",
      get: "supported",
      create: mastraCapabilityStatusOf("workflowCreate"),
      update: mastraCapabilityStatusOf("workflowUpdate"),
      delete: mastraCapabilityStatusOf("workflowDelete"),
      serialize: mastraCapabilityStatusOf("workflowSerialize"),
      persist: mastraCapabilityStatusOf("workflowPersist"),
      version: mastraCapabilityStatusOf("workflowVersion"),
    },
    metrics: {
      runs: mastraCapabilityStatusOf("metricsRuns"),
      scores: mastraCapabilityStatusOf("metricsScores"),
      traces: mastraCapabilityStatusOf("metricsTraces"),
    },
  };
}

/**
 * Looks up one capability row by feature name.
 *
 * @param feature - The engine feature name to look up.
 * @returns The capability row, or `undefined` for an unknown feature.
 */
export function mastraCapabilityOf(
  feature: string
): MastraFeatureCapability | undefined {
  return MASTRA_FEATURE_CAPABILITIES.find((row) => row.feature === feature);
}
