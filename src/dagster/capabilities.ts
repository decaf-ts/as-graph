/**
 * @module as-graph/dagster/capabilities
 * @summary Exported Dagster capability table (read-only driver).
 * @description The wrapper declares, per feature, whether Dagster supports it
 * natively, not at all, or only through an extension point. Under the owner's
 * read-only mandate every authoring/translation feature is `not_supported` with
 * honest detail: the driver lists, looks up, and inspects already-existing
 * Dagster workflows and never authors one. The table is exported both as
 * engine-agnostic {@link GraphBackendCapabilities} (code-mode + workflow
 * listing/lookup) and as the full per-feature table so hosts and servers can
 * surface honest limitations without probing the backend.
 */
import type { GraphBackendCapabilities } from "../engine/execution/GraphExecutionBackend";
import type { DagsterCapabilityRow } from "./DagsterTypes";
import type { DagsterClient } from "./DagsterTypes";

/**
 * The exported Dagster capability table. Every authoring/translation row is
 * `not_supported`: the driver is read-only and never generates, embeds, or emits
 * Python source. The single `supported` row is the read side — listing and
 * inspecting already-deployed jobs through the client port.
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
    detail: "Read-only driver: does not author or launch Dagster runs.",
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
