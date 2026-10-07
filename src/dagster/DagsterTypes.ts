/**
 * @module as-graph/dagster/DagsterTypes
 * @summary Capability, inspection, run, execution, and client-port types for the
 * Dagster backend.
 * @description The Dagster driver never authors workflows and never generates,
 * embeds, or emits Python source. It may list, look up, inspect, and surface
 * ALREADY-EXISTING Dagster workflows through the host-injected
 * {@link DagsterClient} port, and — only behind the explicit
 * {@link DagsterGraphExecutionBackendConfig.executionEnabled} gate — launch a run
 * of an already-deployed job and re-execute an existing run. The wrapper never
 * bundles a phantom JavaScript Dagster runtime.
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
 * The raw Dagster run-status vocabulary the driver may receive. Only `success`,
 * `failure`, and `canceled` are terminal; `started` and the real Dagster pending
 * statuses (`QUEUED`/`STARTING`) are non-terminal and must be polled to a terminal
 * state, a caller abort, or a timeout (C5 fail-closed).
 */
export type DagsterRunStatus =
  | "started"
  | "success"
  | "failure"
  | "canceled"
  | "QUEUED"
  | "STARTING";

/**
 * A Dagster run record. Carries the run's status and, when the port exposes it,
 * the name of the deployed job that owns the run (`jobName`/`pipelineName`), so the
 * driver can bind a run to the workflow it belongs to before replaying it (C1).
 */
export interface DagsterRunRecord {
  /** Dagster run id. */
  runId: string;
  /** Run status. Only `success`/`failure`/`canceled` are terminal. */
  status: DagsterRunStatus;
  /** Workflow output values, when the client exposes them. */
  outputs?: Record<string, unknown>;
  /** Run failure, when the run failed. */
  error?: { message: string; code?: string };
  /** Run start timestamp. */
  startedAt?: string;
  /** Run finish timestamp. */
  finishedAt?: string;
  /** Name of the deployed job that owns the run, when the port exposes it. */
  jobName?: string;
  /** Legacy alias of {@link DagsterRunRecord.jobName}, when the port exposes it. */
  pipelineName?: string;
}

/**
 * The handle a client port returns when it launches or re-executes a run. Carries
 * the new Dagster run id and its (initial or terminal) status; the driver then
 * observes the run through the existing event bridge.
 */
export interface DagsterLaunchedRun {
  /** Dagster run id of the launched/re-executed run. */
  runId: string;
  /**
   * Run status reported by the launch; `started` for a fresh launch, but a real
   * transport may report a pending `QUEUED`/`STARTING` status the driver then
   * polls to terminal.
   */
  status: DagsterRunStatus;
}

/**
 * A request to launch a run of an ALREADY-DEPLOYED Dagster job. The driver only
 * ever sends this behind the explicit execution gate; it never authors a job, op,
 * or Python source — it asks the host transport to launch a job the deployment
 * already defines.
 */
export interface DagsterLaunchRunRequest {
  /** Name of the already-deployed job to launch. */
  jobName: string;
  /**
   * Optional raw Dagster run configuration (the job's `runConfigData`). The host
   * transport forwards it verbatim; the driver never synthesizes it.
   */
  runConfig?: Record<string, unknown>;
  /** Optional run tags (merged by the host with any transport-owned tags). */
  tags?: Record<string, string>;
}

/**
 * A request to re-execute (replay) an EXISTING Dagster run, sent to the host
 * {@link DagsterClient} port. The host transport owns the mechanism: where the
 * GraphQL surface exposes a re-execution mutation it re-executes from the run id,
 * otherwise it re-launches the run's job with the run's original configuration.
 * The driver never authors a job or Python source.
 */
export interface DagsterReplayRunRequest {
  /** Dagster run id of the existing run to replay. */
  dagsterRunId: string;
  /** Optional name of the run's job, when the transport needs it to re-launch. */
  jobName?: string;
  /** Optional run tags (merged by the host with any transport-owned tags). */
  tags?: Record<string, string>;
}

/**
 * A request to replay an EXISTING Dagster run through
 * {@link DagsterGraphExecutionBackend.replayRun}. Carries the run identity, the
 * workflow it belongs to, the facade-owned event sink, and the same observation
 * bounds as {@link DagsterObserveRunRequest}. The driver delegates the actual
 * re-execution to the host transport's `replayRun` and then observes the new run.
 */
export interface DagsterReplayExistingRunRequest {
  /** Dagster run id of the existing run to replay. */
  dagsterRunId: string;
  /** Canonical workflow id (Dagster job name) the run belongs to. */
  workflowId: string;
  /** Facade-owned event sink the driver reports transitions through. */
  events: GraphExecutionEventSink;
  /** Canonical as-graph run id carried on emitted events; defaults to the new run id. */
  graphRunId?: string;
  /** Workflow input values carried onto the canonical result. */
  inputs?: Record<string, unknown>;
  /** Execution options metadata carried onto the canonical result. */
  metadata?: Record<string, unknown>;
  /** Caller cancellation signal, forwarded to the observation bridge. */
  signal?: AbortSignal;
  /** Hard cap on the number of events the bridge processes. */
  maxEvents?: number;
  /** Hard cap on the transport pagination depth. */
  maxPages?: number;
  /** Maximum time to await the terminal record. */
  terminalTimeoutMs?: number;
}

/**
 * A subscription to a Dagster run's event stream.
 */
export interface DagsterRunSubscription {
  /** Stops the subscription. */
  unsubscribe: () => void | Promise<void>;
}

/**
 * Bounds applied to a run-event subscription. The read-only driver passes these
 * through to the host-injected {@link DagsterClient} so a wedged or hostile
 * gateway cannot make the transport page or buffer without limit: `signal` cancels
 * in-flight transport work, `maxEvents` caps the number of events replayed, and
 * `maxPages` caps the pagination depth. Every field is optional so a host port that
 * predates them keeps working.
 */
export interface DagsterRunSubscriptionOptions {
  /** Cancels the subscription and any in-flight transport work. */
  signal?: AbortSignal;
  /** Hard cap on the number of events the transport replays. */
  maxEvents?: number;
  /** Hard cap on the number of pagination pages the transport fetches. */
  maxPages?: number;
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
    handler: (event: DagsterEventRecord) => void,
    options?: DagsterRunSubscriptionOptions
  ): Promise<DagsterRunSubscription>;
  /** Terminates an EXISTING run. */
  terminateRun(runId: string, reason?: string): Promise<void>;
  /** Reads an EXISTING run's terminal record. */
  getRun(runId: string): Promise<DagsterRunRecord>;
  /**
   * Launches a run of an ALREADY-DEPLOYED job. Optional: a read-only host port
   * omits it, and the driver then fails closed with
   * `GRAPH_DAGSTER_EXECUTION_NOT_SUPPORTED`. Called only when the explicit
   * execution gate is enabled.
   */
  launchRun?(request: DagsterLaunchRunRequest): Promise<DagsterLaunchedRun>;
  /**
   * Re-executes (replays) an EXISTING run. Optional: a host without a
   * re-execution surface omits it, and the driver then fails closed with
   * `GRAPH_DAGSTER_REPLAY_NOT_SUPPORTED`. Called only when the explicit execution
   * gate is enabled.
   */
  replayRun?(request: DagsterReplayRunRequest): Promise<DagsterLaunchedRun>;
  /** Disposes the client and its transport. */
  dispose?(): void | Promise<void>;
}

/**
 * Configuration for {@link DagsterGraphExecutionBackend}. The driver accepts no
 * op resolver: it never authors ops. Execution/replay of EXISTING workflows is
 * opt-in and defaults off.
 */
export interface DagsterGraphExecutionBackendConfig
  extends Record<string, unknown> {
  /** Host-injected Dagster client port (read surface always; launch/replay when enabled). */
  client: DagsterClient;
  /** Optional host-supplied default run tags. */
  tags?: Record<string, string>;
  /**
   * Explicit opt-in for executing (launching a run of an already-deployed job)
   * and replaying (re-executing an existing run) through the client port. Defaults
   * to `false`: when off, `execute`/`replayRun` fail closed with
   * `GRAPH_DAGSTER_EXECUTION_NOT_ENABLED` before any network call, and the driver
   * remains purely read-only. The facade preserves this key across
   * `GraphExecutionEngine.initialize` (it is not facade-owned).
   */
  executionEnabled?: boolean;
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
  /**
   * Caller cancellation signal. Aborting it fails the observation closed with
   * `GRAPH_DAGSTER_OBSERVE_ABORTED` and cancels in-flight transport work
   * instead of leaving the caller waiting on a wedged or stalled run.
   */
  signal?: AbortSignal;
  /**
   * Hard cap on the number of events the bridge will process. Exceeding it fails
   * the observation closed with `GRAPH_DAGSTER_EVENT_LIMIT_EXCEEDED`, so a gateway
   * that never terminates cannot accumulate events without bound.
   */
  maxEvents?: number;
  /**
   * Hard cap on the transport pagination depth. Forwarded to the client port so a
   * gateway whose `eventConnection` never reports `hasMore: false` cannot page
   * without bound.
   */
  maxPages?: number;
  /**
   * Maximum time to await the terminal record. Exceeding it fails the observation
   * closed with `GRAPH_DAGSTER_OBSERVE_TIMEOUT`.
   */
  terminalTimeoutMs?: number;
}
