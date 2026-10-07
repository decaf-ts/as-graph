/**
 * @module as-graph/dagster/DagsterTypes
 * @summary Read-only capability, inspection, run, and client-port types for the
 * Dagster backend.
 * @description The Dagster driver is read-only by owner mandate: it may only list,
 * look up, inspect, and surface ALREADY-EXISTING Dagster workflows. It never
 * authors workflows and never generates, embeds, or emits Python source. The driver
 * talks to Dagster through the host-injected {@link DagsterClient} port, so the
 * wrapper never bundles a phantom JavaScript Dagster runtime.
 */
import type { GraphExecutionEventSink } from "../engine/execution/GraphExecutionBackend";

/**
 * A capability verdict row in the exported Dagster capability table.
 */
export type DagsterCapabilityVerdict =
  | "supported"
  | "not_supported"
  | "extension_point";

/**
 * A single row of the exported Dagster capability table.
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
 * A raw Dagster event record surfaced by the client port.
 */
export interface DagsterEventRecord {
  /** Raw Dagster event type (e.g. `STEP_START`, `STEP_SUCCESS`). */
  type: string;
  /** Dagster step key; maps to a canonical node id via the inspected job map. */
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
  unsubscribe: () => void | Promise<void>;
}

/**
 * A Dagster job summary surfaced by workflow listing.
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
 * One op/step of a deployed Dagster job, as exposed by the client port.
 * `nodeId` and `kind` are optional because a deployment may not classify its ops;
 * the driver falls back to the op `name` and {@link DAGSTER_DEFAULT_NODE_KIND}.
 */
export interface DagsterJobOp {
  /** Dagster op/step name. */
  name: string;
  /** Canonical node id, when the deployment exposes one. */
  nodeId?: string;
  /** Canonical node kind, when the deployment exposes one. */
  kind?: string;
  /** Op input names, when the deployment exposes them. */
  inputs?: string[];
  /** Op output names, when the deployment exposes them. */
  outputs?: string[];
  /** Asset keys the op materializes, when the deployment exposes them. */
  assetKeys?: string[];
}

/**
 * A directed op dependency of a deployed Dagster job: `from` feeds `to`.
 */
export interface DagsterJobDependency {
  /** Upstream op name. */
  from: string;
  /** Downstream op name. */
  to: string;
}

/**
 * A schedule declared by a deployed Dagster job, when the deployment exposes it.
 */
export interface DagsterJobSchedule {
  /** Schedule name. */
  name: string;
  /** Cron expression, when exposed. */
  cron?: string;
  /** IANA timezone, when exposed. */
  timezone?: string;
}

/**
 * A sensor declared by a deployed Dagster job, when the deployment exposes it.
 */
export interface DagsterJobSensor {
  /** Sensor name. */
  name: string;
  /** Sensor kind, when exposed. */
  kind?: string;
}

/**
 * A deployed Dagster job record surfaced by workflow lookup. Carries the actual
 * deployment structure the driver maps into the canonical document shape: the job
 * name, graph/op structure, asset keys, and schedules/sensors where the client
 * port exposes them. Every field is read-only inspection data — no op body, no
 * Python source.
 */
export interface DagsterJobRecord {
  /** Job name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Optional last-update timestamp. */
  updatedAt?: Date;
  /** Ops/steps of the job's graph, when the deployment exposes them. */
  ops?: DagsterJobOp[];
  /** Directed op dependencies, when the deployment exposes them. */
  dependencies?: DagsterJobDependency[];
  /** Asset keys the job reads/materializes, when the deployment exposes them. */
  assetKeys?: string[];
  /** Schedules attached to the job, when the deployment exposes them. */
  schedules?: DagsterJobSchedule[];
  /** Sensors attached to the job, when the deployment exposes them. */
  sensors?: DagsterJobSensor[];
}

/**
 * Host-injected, read-only Dagster client port. Abstracts the GraphQL/REST
 * transport so the wrapper stays a pure inspection + event-mapping layer and the
 * host owns the Dagster deployment. Listing/lookup are required: the owner mandate
 * makes reading already-existing workflows the driver's core responsibility.
 */
export interface DagsterClient {
  /** Lists already-deployed Dagster jobs. */
  listJobs(): Promise<DagsterJobSummary[]>;
  /** Reads a single already-deployed Dagster job, including its graph structure. */
  getJob(jobName: string): Promise<DagsterJobRecord>;
  /** Subscribes to an EXISTING run's raw event stream. */
  subscribeRun(
    runId: string,
    handler: (event: DagsterEventRecord) => void
  ): Promise<DagsterRunSubscription>;
  /** Terminates an EXISTING run. */
  terminateRun(runId: string, reason?: string): Promise<void>;
  /** Reads an EXISTING run's terminal record. */
  getRun(runId: string): Promise<DagsterRunRecord>;
  /** Disposes the client and its transport. */
  dispose?(): void | Promise<void>;
}

/**
 * Configuration for {@link DagsterGraphExecutionBackend}. The driver no longer
 * accepts an op resolver: it never authors ops.
 */
export interface DagsterGraphExecutionBackendConfig
  extends Record<string, unknown> {
  /** Host-injected, read-only Dagster client port. */
  client: DagsterClient;
  /** Optional host-supplied default run tags. */
  tags?: Record<string, string>;
}

/**
 * A request to observe an EXISTING Dagster run. The run is never launched by the
 * driver; the caller supplies the id of a run that already exists in the
 * deployment.
 */
export interface DagsterObserveRunRequest {
  /** Dagster run id of the existing run. */
  dagsterRunId: string;
  /** Canonical as-graph run id carried on emitted events; defaults to the Dagster run id. */
  graphRunId?: string;
  /** Canonical workflow id the run belongs to. */
  workflowId: string;
  /** Facade-owned event sink the driver reports transitions through. */
  events: GraphExecutionEventSink;
  /** Workflow input values carried onto the canonical result. */
  inputs?: Record<string, unknown>;
  /** Execution options metadata carried onto the canonical result. */
  metadata?: Record<string, unknown>;
}
