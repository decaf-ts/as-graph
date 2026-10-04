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
import type { GraphBackendCapabilities } from "../engine/execution/GraphExecutionBackend";

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
];

/**
 * Engine-agnostic capability projection of the Mastra backend: no in-process
 * code execution, and workflow list/lookup are supported over the
 * compiled-workflow cache.
 *
 * @returns The {@link GraphBackendCapabilities} served by the Mastra backend.
 */
export function resolveMastraCapabilities(): GraphBackendCapabilities {
  return {
    codeMode: "unsupported",
    workflows: { list: "supported", get: "supported" },
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
