/**
 * @module as-graph/dagster/DagsterTypes
 * @summary Artifact, capability, and client-port types for the Dagster backend (SAA-195).
 * @description The translator emits a `DagsterJobArtifact`: a deterministic,
 * inspectable description of the Dagster module for a workflow plus the generated
 * Python source. The backend talks to Dagster through the host-injected
 * {@link DagsterClient} port, so the wrapper never bundles a phantom JavaScript
 * Dagster runtime.
 */
import type { GraphJsonValue } from "../shared/graph";
import type { GraphWorkflowDocument } from "../shared/graph";

/**
 * A capability verdict row in the exported Dagster capability table.
 */
export type DagsterCapabilityVerdict =
  | "supported"
  | "not_supported"
  | "extension_point";

/**
 * A single row of the exported Dagster capability table (SAA-195 §4.4).
 */
export interface DagsterCapabilityRow {
  /** The engine feature being described. */
  feature: string;
  /** Whether Dagster supports it natively, not at all, or via an extension point. */
  verdict: DagsterCapabilityVerdict;
  /** Human-readable detail for the verdict. */
  detail: string;
}

/**
 * The role a generated op plays in the Dagster graph.
 */
export type DagsterOpRole = "generic" | "router" | "foreach" | "trigger";

/**
 * A generated Dagster op.
 */
export interface DagsterOpArtifact {
  /** Canonical node id the op was generated from. */
  nodeId: string;
  /** Canonical node kind. */
  kind: string;
  /** Sanitized Python op name. */
  opName: string;
  /** The op's role in the graph. */
  role: DagsterOpRole;
  /** Sanitized input port names. */
  inputs: string[];
  /** Sanitized output port names. */
  outputs: string[];
  /** Output ports emitted optionally (router branches). */
  optionalOutputs: string[];
  /** Node configuration data embedded in run config (never in code). */
  config: Record<string, GraphJsonValue>;
  /** Generated Python source for the op. */
  code: string;
}

/**
 * A generated Dagster schedule.
 */
export interface DagsterScheduleArtifact {
  /** Canonical node id the schedule was generated from. */
  nodeId: string;
  /** Sanitized schedule name. */
  name: string;
  /** Cron expression (data, carried in the schedule definition). */
  cron: string;
  /** IANA timezone, when declared. */
  timezone?: string;
  /** Generated Python source for the schedule. */
  code: string;
}

/**
 * A generated Dagster sensor.
 */
export interface DagsterSensorArtifact {
  /** Canonical node id the sensor was generated from. */
  nodeId: string;
  /** Sanitized sensor name. */
  name: string;
  /** The trigger kind the sensor represents. */
  triggerKind: string;
  /** Generated Python source for the sensor. */
  code: string;
}

/**
 * Dagster run configuration: node parameters as data keyed by sanitized op name.
 * Parameters travel here, never inlined into generated op bodies (SAA-193 C6).
 */
export interface DagsterRunConfig {
  ops: Record<string, { config: Record<string, GraphJsonValue> }>;
}

/**
 * A complete, deterministic Dagster translation of a workflow document.
 */
export interface DagsterJobArtifact {
  /** Canonical workflow id. */
  workflowId: string;
  /** Sanitized Dagster graph name. */
  graphName: string;
  /** Sanitized Dagster job name. */
  jobName: string;
  /** Pinned Dagster version the artifact targets. */
  pinnedVersion: string;
  /** Provenance of the pin. */
  pinnedSource: string;
  /** Stable document fingerprint the artifact was translated from. */
  fingerprint: string;
  /** Python modules the generated artifact imports (allowlist-enforced). */
  imports: string[];
  /** Canonical node id → sanitized op name. */
  opNamesByNodeId: Record<string, string>;
  /** Sanitized op name → canonical node id. */
  nodeIdsByOpName: Record<string, string>;
  /** Generated ops. */
  ops: DagsterOpArtifact[];
  /** Run configuration carrying node parameters as data. */
  runConfig: DagsterRunConfig;
  /** Namespaced run tags carrying tracing data only. */
  tags: Record<string, string>;
  /** Generated schedules. */
  schedules: DagsterScheduleArtifact[];
  /** Generated sensors. */
  sensors: DagsterSensorArtifact[];
  /** The exported capability table for this translation. */
  capabilities: DagsterCapabilityRow[];
  /** The full generated Python module source. */
  python: string;
}

/**
 * A host-authored op override for a node kind. The host is trusted to provide a
 * fixed body; it must not interpolate user data (SAA-193 C4/C6).
 */
export interface DagsterResolvedOp {
  /** Fixed Python statements returning the op's output. */
  body: string;
  /** Overridden input port names, when any. */
  inputs?: string[];
  /** Overridden output port names, when any. */
  outputs?: string[];
}

/**
 * Host extension point resolving a node kind to a Dagster op. When a kind is not a
 * built-in and no resolver handles it, translation fails loudly (SAA-193 §7.3).
 */
export type DagsterOpResolver = (
  kind: string,
  document: GraphWorkflowDocument
) => DagsterResolvedOp | undefined;

/**
 * A request to launch a Dagster run.
 */
export interface DagsterLaunchRequest {
  /** Sanitized job name to launch. */
  jobName: string;
  /** Run configuration carrying node parameters as data. */
  runConfig: DagsterRunConfig;
  /** Namespaced run tags. */
  tags: Record<string, string>;
  /** Fingerprint of the translated document. */
  documentFingerprint: string;
  /** Canonical workflow id. */
  workflowId: string;
}

/**
 * A handle to a launched Dagster run.
 */
export interface DagsterRunHandle {
  /** Dagster run id. */
  runId: string;
  /** Job the run launched. */
  jobName: string;
}

/**
 * A raw Dagster event record surfaced by the client port.
 */
export interface DagsterEventRecord {
  /** Raw Dagster event type (e.g. `STEP_START`, `STEP_SUCCESS`). */
  type: string;
  /** Dagster step key; maps to a node id via the artifact's op map. */
  stepKey?: string;
  /** ISO-8601 event timestamp. */
  timestamp?: string;
  /** Raw event payload (outputs, errors, ...). */
  payload?: Record<string, unknown>;
  /** Raw human-readable message. */
  message?: string;
}

/**
 * A terminal Dagster run record.
 */
export interface DagsterRunRecord {
  /** Dagster run id. */
  runId: string;
  /** Terminal run status. */
  status: "started" | "success" | "failure" | "canceled";
  /** Workflow output values, when the client exposes them. */
  outputs?: Record<string, unknown>;
  /** Run failure, when the run failed. */
  error?: { message: string; code?: string };
  /** Run start timestamp. */
  startedAt?: string;
  /** Run finish timestamp. */
  finishedAt?: string;
}

/**
 * A subscription to a Dagster run's event stream.
 */
export interface DagsterRunSubscription {
  /** Stops the subscription. */
  unsubscribe(): void | Promise<void>;
}

/**
 * A Dagster job summary surfaced by workflow listing (Deliverable 4 addendum).
 */
export interface DagsterJobSummary {
  /** Job name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Optional last-update timestamp. */
  updatedAt?: Date;
}

/**
 * A Dagster job record surfaced by workflow lookup (Deliverable 4 addendum).
 */
export interface DagsterJobRecord {
  /** Job name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Optional last-update timestamp. */
  updatedAt?: Date;
}

/**
 * Host-injected Dagster client port. Abstracts the GraphQL/REST transport so the
 * wrapper stays a pure translation + event-mapping layer and the host owns the
 * Dagster deployment. Listing/lookup are optional; when absent the backend
 * declares them `not_supported` rather than returning an empty result.
 */
export interface DagsterClient {
  /** Launches a run for a translated job. */
  launchRun(request: DagsterLaunchRequest): Promise<DagsterRunHandle>;
  /** Subscribes to a run's raw event stream. */
  subscribeRun(
    runId: string,
    handler: (event: DagsterEventRecord) => void
  ): Promise<DagsterRunSubscription>;
  /** Terminates a run. */
  terminateRun(runId: string, reason?: string): Promise<void>;
  /** Reads a run's terminal record. */
  getRun(runId: string): Promise<DagsterRunRecord>;
  /** Lists deployed Dagster jobs, when the deployment exposes them. */
  listJobs?(): Promise<DagsterJobSummary[]>;
  /** Reads a single deployed Dagster job, when the deployment exposes it. */
  getJob?(jobName: string): Promise<DagsterJobRecord>;
  /** Disposes the client and its transport. */
  dispose?(): void | Promise<void>;
}

/**
 * Configuration for {@link DagsterGraphExecutionBackend}.
 */
export interface DagsterGraphExecutionBackendConfig
  extends Record<string, unknown> {
  /** Host-injected Dagster client port. */
  client: DagsterClient;
  /** Optional host op resolver extension point for non-built-in kinds. */
  opResolver?: DagsterOpResolver;
  /** Optional host-supplied default run tags. */
  tags?: Record<string, string>;
}
