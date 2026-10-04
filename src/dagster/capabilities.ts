/**
 * @module as-graph/dagster/capabilities
 * @summary Exported Dagster capability table (SAA-195 §4.4, Deliverable 4 addendum).
 * @description The wrapper declares, per feature, whether Dagster supports it
 * natively, not at all, or only through an extension point. The table is exported
 * both as engine-agnostic {@link GraphBackendCapabilities} (code-mode + workflow
 * listing/lookup) and as the full per-feature translation table so hosts and servers
 * can surface honest limitations without probing the backend.
 */
import type { GraphBackendCapabilities } from "../engine/execution/GraphExecutionBackend";
import type { DagsterCapabilityRow } from "./DagsterTypes";
import type { DagsterClient } from "./DagsterTypes";

/**
 * The exported Dagster capability table (SAA-195 §4.4). Every row names a feature
 * and whether Dagster supports it natively, not at all, or only through a declared
 * extension point. `while`/`until`, `humanApproval`, and `break` are declared
 * NOT-SUPPORTED so the translator fails loudly rather than silently dropping them.
 */
export const DAGSTER_CAPABILITY_TABLE: DagsterCapabilityRow[] = [
  {
    feature: "sequential / generic node",
    verdict: "supported",
    detail:
      "One delegating Dagster op per node; execution dispatched through the as_graph resource.",
  },
  {
    feature: "if / switch routing",
    verdict: "supported",
    detail:
      "Router op with optional outputs; routes carried as run config data.",
  },
  {
    feature: "foreach iteration",
    verdict: "supported",
    detail: "DynamicOut fan-out with map/collect composition.",
  },
  {
    feature: "while / until loop",
    verdict: "not_supported",
    detail:
      "Dagster has no native loop op; declared NOT-SUPPORTED and fails loudly. Extension point: sensor-driven re-launch.",
  },
  {
    feature: "suspend / resume",
    verdict: "not_supported",
    detail:
      "Dagster OSS has no suspend/resume; declared NOT-SUPPORTED (SAA-196 extension point).",
  },
  {
    feature: "human approval",
    verdict: "not_supported",
    detail: "No OSS equivalent; declared NOT-SUPPORTED and fails loudly.",
  },
  {
    feature: "code-mode surface",
    verdict: "not_supported",
    detail:
      "Rejected before translation with GRAPH_DAGSTER_CODE_MODE_UNSUPPORTED (SAA-193 C2).",
  },
  {
    feature: "schedule trigger",
    verdict: "supported",
    detail: "Translated to a Dagster ScheduleDefinition.",
  },
  {
    feature: "webhook / event / form / chat trigger",
    verdict: "supported",
    detail: "Translated to a Dagster sensor polling the as_graph resource.",
  },
  {
    feature: "manual trigger",
    verdict: "extension_point",
    detail: "Entrypoint with no Dagster trigger artifact; host launches the job.",
  },
  {
    feature: "agent / custom node kinds",
    verdict: "extension_point",
    detail:
      "Host-supplied DagsterOpResolver provides the fixed op body; unmapped kinds fail loudly.",
  },
];

/**
 * Resolves the engine-agnostic Dagster backend capabilities. Code-mode is always
 * `unsupported` (SAA-193 C1/C2); workflow listing/lookup is supported exactly
 * when the wired client port exposes `listJobs`/`getJob`.
 *
 * @param client - The wired Dagster client port, when any.
 * @returns The engine-agnostic capability metadata.
 */
export function dagsterBackendCapabilities(
  client?: DagsterClient
): GraphBackendCapabilities {
  return {
    codeMode: "unsupported",
    workflows: {
      list: typeof client?.listJobs === "function" ? "supported" : "not_supported",
      get: typeof client?.getJob === "function" ? "supported" : "not_supported",
    },
  };
}
