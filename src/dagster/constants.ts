/**
 * @module as-graph/dagster/constants
 * @summary Constants for the Dagster graph driver.
 * @description Pinned Dagster engine version/source and the machine-readable
 * error codes the driver raises. Dagster is a Python orchestration engine with no
 * official JavaScript runtime, so this driver never authors workflows and never
 * generates, embeds, or emits Python source: it lists, looks up, and inspects
 * already-deployed Dagster jobs through the host-injected client port, and — only
 * behind an explicit `executionEnabled` config gate — launches and re-executes
 * EXISTING workflows through that same port. The pin records which engine contract
 * the inspected deployment targets.
 */

/**
 * Backend flavour under which {@link DagsterGraphExecutionBackend} registers itself
 * in the {@link GraphExecutionBackendRegistry}.
 */
export const DAGSTER_BACKEND_FLAVOUR = "dagster";

/**
 * Pinned Dagster engine version. Verified as the latest release on PyPI
 * (`https://pypi.org/pypi/dagster/json`) at implementation time and reported
 * alongside the inspected deployment so a lookup is always traceable to the engine
 * contract it targets. The read-only driver never emits an artifact header.
 */
export const DAGSTER_PINNED_VERSION = "1.13.25";

/**
 * Provenance of the {@link DAGSTER_PINNED_VERSION} pin (the PyPI JSON metadata
 * endpoint the version was read from).
 */
export const DAGSTER_PINNED_SOURCE = "https://pypi.org/pypi/dagster/json";

/**
 * PyPI distribution name of the pinned engine.
 */
export const DAGSTER_PINNED_DISTRIBUTION = "dagster";

/**
 * Run-tag namespace for the tracing data the driver attaches when it observes an
 * existing Dagster run. Free-form document strings never enter generated code
 * because the driver generates none; they travel as run tags under this namespace
 * only.
 */
export const DAGSTER_TAG_NAMESPACE = "as-graph/";

/**
 * Canonical node kind assigned to a Dagster op the deployment does not classify.
 * The deployment's own op kind is used verbatim when the client port exposes one.
 */
export const DAGSTER_DEFAULT_NODE_KIND = "dagster.op";

/**
 * Machine-readable error codes raised by the read-only Dagster driver.
 */
export const DAGSTER_ERROR = {
  /** A workflow-authoring operation was requested from the read-only driver. */
  AUTHORING_NOT_SUPPORTED: "GRAPH_DAGSTER_AUTHORING_NOT_SUPPORTED",
  /** Execution/replay was requested but the explicit config gate is off. */
  EXECUTION_NOT_ENABLED: "GRAPH_DAGSTER_EXECUTION_NOT_ENABLED",
  /** Execution was requested but the client port exposes no `launchRun`. */
  EXECUTION_NOT_SUPPORTED: "GRAPH_DAGSTER_EXECUTION_NOT_SUPPORTED",
  /** Replay was requested but the client port exposes no `replayRun`. */
  REPLAY_NOT_SUPPORTED: "GRAPH_DAGSTER_REPLAY_NOT_SUPPORTED",
  /** The client failed to launch or re-execute the run. */
  RUN_LAUNCH_FAILED: "GRAPH_DAGSTER_RUN_LAUNCH_FAILED",
  /**
   * A run or document's declared job does not belong to the requested workflow
   * (BOLA guard): replay of a foreign run and a metadata-steered launch are
   * rejected before any launch, and the check fails closed when the owning job
   * cannot be determined.
   */
  RUN_WORKFLOW_MISMATCH: "GRAPH_DAGSTER_RUN_WORKFLOW_MISMATCH",
  /** The caller-supplied raw run config is not a JSON-safe allowlisted object. */
  RUN_CONFIG_INVALID: "GRAPH_DAGSTER_RUN_CONFIG_INVALID",
  /** A workflow carries a code-mode surface; the driver cannot author or run it. */
  CODE_MODE_UNSUPPORTED: "GRAPH_DAGSTER_CODE_MODE_UNSUPPORTED",
  /** A backend operation was requested without a wired Dagster client port. */
  CLIENT_NOT_CONFIGURED: "GRAPH_DAGSTER_CLIENT_NOT_CONFIGURED",
  /** Workflow listing/lookup was requested but the client port does not expose it. */
  WORKFLOWS_NOT_SUPPORTED: "GRAPH_DAGSTER_WORKFLOWS_NOT_SUPPORTED",
  /** A Dagster event type has no engine-agnostic mapping. */
  EVENT_UNSUPPORTED: "GRAPH_DAGSTER_EVENT_UNSUPPORTED",
  /** The client failed to read, subscribe to, or terminate the run. */
  RUN_FAILED: "GRAPH_DAGSTER_RUN_FAILED",
  /** The caller aborted the observation before the run reached a terminal state. */
  OBSERVE_ABORTED: "GRAPH_DAGSTER_OBSERVE_ABORTED",
  /** The run did not reach a terminal state within the observation timeout. */
  OBSERVE_TIMEOUT: "GRAPH_DAGSTER_OBSERVE_TIMEOUT",
  /** The run emitted more events than the observation's `maxEvents` cap. */
  EVENT_LIMIT_EXCEEDED: "GRAPH_DAGSTER_EVENT_LIMIT_EXCEEDED",
  /** The transport paginated more pages than the observation's `maxPages` cap. */
  PAGE_LIMIT_EXCEEDED: "GRAPH_DAGSTER_PAGE_LIMIT_EXCEEDED",
} as const;
