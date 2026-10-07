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
 * The full Mastra backend capability projection: the engine-agnostic
 * {@link GraphBackendCapabilities} plus the Mastra-specific workflow-management
 * statuses.
 */
export interface MastraBackendCapabilities extends GraphBackendCapabilities {
  /** Workflow list/lookup plus the management statuses. */
  workflows: GraphBackendCapabilities["workflows"] &
    MastraWorkflowManagementCapabilities;
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
