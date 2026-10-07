/**
 * @module as-graph/dagster/capabilities
 * @summary Exported Dagster capability table.
 * @description The wrapper declares, per feature, whether Dagster supports it
 * natively, not at all, or only through an extension point. Every
 * authoring/translation feature is `not_supported` with honest detail: the driver
 * never authors a Dagster workflow or emits Python. The read side (listing and
 * inspecting already-deployed jobs) is `supported`, and executing/replaying
 * EXISTING workflows is `supported` behind the explicit `executionEnabled` config
 * gate (fails closed with `GRAPH_DAGSTER_EXECUTION_NOT_ENABLED` when off). The
 * table is exported both as engine-agnostic {@link GraphBackendCapabilities}
 * (code-mode + workflow listing/lookup) and as the full per-feature table so hosts
 * and servers can surface honest limitations without probing the backend.
 */
import type { GraphBackendCapabilities } from "../engine/execution/GraphExecutionBackend";
import type { DagsterCapabilityRow } from "./DagsterTypes";
import type { DagsterClient } from "./DagsterTypes";

/**
 * The exported Dagster capability table. Every authoring/translation row is
 * `not_supported`: the driver never generates, embeds, or emits Python source. The
 * `supported` rows are the read side (listing/inspecting already-deployed jobs)
 * and the gated execution of EXISTING workflows (launch a run / replay an existing
 * run), which is opt-in via the `executionEnabled` config gate.
 */
export const DAGSTER_CAPABILITY_TABLE: DagsterCapabilityRow[] = [
  {
    feature: "sequential / generic node",
    verdict: "not_supported",
    detail:
      "Read-only driver: does not author Dagster ops for workflow nodes.",
  },
  {
    feature: "if / switch routing",
    verdict: "not_supported",
    detail: "Read-only driver: does not author Dagster router ops.",
  },
  {
    feature: "foreach iteration",
    verdict: "not_supported",
    detail: "Read-only driver: does not author Dagster dynamic fan-out ops.",
  },
  {
    feature: "while / until loop",
    verdict: "not_supported",
    detail:
      "Read-only driver: does not author Dagster loops, which the engine has no native op for.",
  },
  {
    feature: "suspend / resume",
    verdict: "not_supported",
    detail:
      "Read-only driver: does not author Dagster suspend/resume, which OSS Dagster has no primitive for.",
  },
  {
    feature: "human approval",
    verdict: "not_supported",
    detail:
      "Read-only driver: does not author Dagster human-approval steps, which OSS Dagster has no equivalent for.",
  },
  {
    feature: "code-mode surface",
    verdict: "not_supported",
    detail:
      "Read-only driver: rejected with GRAPH_DAGSTER_CODE_MODE_UNSUPPORTED; never authored or run.",
  },
  {
    feature: "schedule trigger",
    verdict: "not_supported",
    detail: "Read-only driver: does not author Dagster schedules.",
  },
  {
    feature: "webhook / event / form / chat trigger",
    verdict: "not_supported",
    detail: "Read-only driver: does not author Dagster sensors.",
  },
  {
    feature: "manual trigger",
    verdict: "not_supported",
    detail:
      "Driver: does not author Dagster triggers. Launching a run of an already-deployed job is the separate, gated `execute existing workflow` capability.",
  },
  {
    feature: "agent / custom node kinds",
    verdict: "not_supported",
    detail:
      "Read-only driver: does not author Dagster ops for custom node kinds.",
  },
  {
    feature: "list / inspect existing workflows",
    verdict: "supported",
    detail:
      "Lists and inspects already-deployed Dagster jobs through the read-only client port.",
  },
  {
    feature: "execute existing workflow (launch run)",
    verdict: "supported",
    detail:
      "Launches a run of an already-deployed Dagster job and observes it to a canonical result. The canonical job is bound from the requested workflow id (`getJob`); a document whose `metadata.dagsterJobName` names a different job is rejected. The optional raw `metadata.dagsterRunConfig` object is forwarded verbatim as Dagster `runConfigData`, and its shape is allowlisted to JSON-safe values only. Gated: requires `executionEnabled: true` on the backend config and fails closed with GRAPH_DAGSTER_EXECUTION_NOT_ENABLED when off.",
  },
  {
    feature: "replay / re-execute existing run",
    verdict: "supported",
    detail:
      "Re-executes an existing Dagster run and observes the new run to a canonical result. The supplied run id is bound to the requested workflow id (`getRun`); a cross-job run is rejected with GRAPH_DAGSTER_RUN_WORKFLOW_MISMATCH. Gated by the same `executionEnabled` config and fails closed with GRAPH_DAGSTER_EXECUTION_NOT_ENABLED when off.",
  },
];

/**
 * Resolves the engine-agnostic Dagster backend capabilities. Code-mode is always
 * `unsupported`; workflow listing/lookup is supported exactly when the wired
 * client port exposes `listJobs`/`getJob`.
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
      list:
        typeof client?.listJobs === "function" ? "supported" : "not_supported",
      get: typeof client?.getJob === "function" ? "supported" : "not_supported",
    },
  };
}
