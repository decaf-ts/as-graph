/**
 * @module as-graph/dagster/DagsterGraphExecutionBackend
 * @summary Dagster graph backend: read-only surface plus gated execute/replay of
 * EXISTING workflows (DECAF-50 §4.9).
 * @description A non-local {@link GraphExecutionBackend} that lists, looks up,
 * and inspects ALREADY-EXISTING Dagster workflows through a host-injected
 * {@link DagsterClient} port, and — only when the explicit
 * {@link DagsterGraphExecutionBackendConfig.executionEnabled} gate is on — launches
 * a run of an already-deployed job and re-executes an existing run. By owner
 * mandate the driver never authors a workflow and never generates, embeds, or emits
 * Python source:
 *
 * - `listWorkflows`/`getWorkflow` map the real deployment structure (job name,
 *   graph/op structure, asset keys, schedules/sensors) into the canonical summary
 *   and document shapes;
 * - `observeRun` surfaces the events of an EXISTING run and maps its terminal
 *   record onto a canonical result;
 * - `execute` fails closed with `GRAPH_DAGSTER_EXECUTION_NOT_ENABLED` when the gate
 *   is off (before any network call); when on, it launches a run of the job the
 *   supplied document describes through `client.launchRun` and observes it through
 *   the existing event bridge. It never translates a document into Python;
 * - `replayRun` fails closed with `GRAPH_DAGSTER_EXECUTION_NOT_ENABLED` when the
 *   gate is off; when on, it delegates re-execution of an existing run to the
 *   host transport's `client.replayRun`;
 * - it declares `local = false` and `codeMode = "unsupported"`, so the facade fails
 *   closed on any code-mode surface before delegating;
 * - it never reads, sets, or reconfigures a code sandbox evaluator.
 */
import type { GraphWorkflowDocument } from "../shared/graph";
import type {
  GraphEdgeInstance,
  GraphNodeInstance,
} from "../shared/graph";
import { GraphExecutionError } from "../engine/errors";
import type {
  GraphBackendCapabilities,
  GraphBackendExecutionRequest,
  GraphBackendWorkflowSummary,
  GraphExecutionBackend,
  GraphExecutionEventSink,
} from "../engine/execution/GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../engine/execution/GraphExecutionBackendRegistry";
import type {
  GraphExecutionResult,
  GraphExecutionValues,
  GraphRunId,
} from "../engine/types";
import {
  DAGSTER_BACKEND_FLAVOUR,
  DAGSTER_DEFAULT_NODE_KIND,
  DAGSTER_ERROR,
  DAGSTER_TAG_NAMESPACE,
} from "./constants";
import type {
  DagsterClient,
  DagsterGraphExecutionBackendConfig,
  DagsterJobOp,
  DagsterJobRecord,
  DagsterLaunchedRun,
  DagsterObserveRunRequest,
  DagsterReplayExistingRunRequest,
  DagsterRunRecord,
  DagsterRunStatus,
} from "./DagsterTypes";
import { dagsterBackendCapabilities } from "./capabilities";
import { DagsterGraphEventBridge } from "./DagsterGraphEventBridge";
import { DagsterResultMapper } from "./DagsterResultMapper";

/**
 * Default maximum time (ms) `execute`/`replayRun` await a launched/re-executed run
 * to reach a terminal state before failing the operation closed. Matches the event
 * bridge's default terminal timeout.
 */
const DEFAULT_EXECUTION_TERMINAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Default interval (ms) between `getRun` polls while awaiting a launched run's
 * terminal state. The driver waits through the read-only `getRun` surface and then
 * observes the completed run through the event bridge.
 */
const DEFAULT_EXECUTION_POLL_INTERVAL_MS = 500;

/**
 * The Dagster run statuses that are terminal. Only these end the terminal wait;
 * every other status (including the real pending `QUEUED`/`STARTING`) is polled
 * toward terminal, caller abort, or timeout (C5 fail-closed).
 */
const DAGSTER_TERMINAL_RUN_STATUSES: ReadonlySet<DagsterRunStatus> = new Set([
  "success",
  "failure",
  "canceled",
]);

/**
 * Maximum accepted nesting depth of the allowlisted raw run config. Bounds the shape
 * check so a deeply nested object cannot be forwarded as a transport bomb.
 */
const DAGSTER_RUN_CONFIG_MAX_DEPTH = 16;

/**
 * Resolves the canonical node id of an inspected op. The deployment's own node id
 * is used when exposed; otherwise the op name is the identity.
 *
 * @param op - The inspected Dagster op.
 * @returns The canonical node id.
 */
function dagsterNodeIdOf(op: DagsterJobOp): string {
  return op.nodeId ?? op.name;
}

/**
 * Builds the inspected job's op-name → canonical node-id map. The event bridge
 * uses it to resolve Dagster step keys onto canonical node ids for an existing run.
 *
 * @param job - The inspected Dagster job record.
 * @returns The op-name → node-id map.
 */
export function dagsterNodeIdsByOpName(
  job: DagsterJobRecord
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const op of job.ops ?? []) {
    map[op.name] = dagsterNodeIdOf(op);
  }
  return map;
}

/**
 * Builds the op-name → canonical node-id map from an already-mapped canonical
 * document. The event bridge uses it to resolve Dagster step keys onto canonical
 * node ids for a run the driver launched from that document, without re-reading
 * the job.
 *
 * @param document - The canonical document of the launched job.
 * @returns The op-name → node-id map.
 */
export function dagsterNodeIdsByOpNameFromDocument(document: {
  nodes?: ReadonlyArray<{
    id: string;
    metadata?: Record<string, unknown>;
  }>;
}): Record<string, string> {
  const map: Record<string, string> = {};
  for (const node of document.nodes ?? []) {
    const opName = node.metadata?.["dagsterOpName"];
    if (typeof opName === "string") map[opName] = node.id;
  }
  return map;
}

/**
 * Resolves the canonical workflow id a document describes from the document's own
 * identity — never from its metadata. The document id wins; the document name is the
 * fallback. Untrusted metadata can never steer which deployed job is selected (C2).
 *
 * @param document - The canonical workflow document.
 * @returns The canonical workflow id.
 */
function dagsterCanonicalWorkflowIdOf(document: {
  id?: string;
  name?: string;
}): string {
  return document.id || document.name || "";
}

/**
 * Deep-clones a caller-supplied raw Dagster run config through a JSON-safe
 * allowlist: only finite numbers, strings, booleans, `null`, arrays, and plain
 * objects survive. Functions, symbols, `undefined`, class instances, dates, maps,
 * and cyclic/over-deep structures are rejected with
 * `GRAPH_DAGSTER_RUN_CONFIG_INVALID` (C4).
 *
 * @param value - The raw run config value to allowlist.
 * @param depth - The current nesting depth.
 * @returns The allowlisted clone.
 * @throws {GraphExecutionError} `GRAPH_DAGSTER_RUN_CONFIG_INVALID` when the value
 *   is not JSON-safe.
 */
function dagsterAllowlistedRunConfig(
  value: Record<string, unknown>,
  depth: number
): Record<string, unknown> {
  if (depth > DAGSTER_RUN_CONFIG_MAX_DEPTH) {
    throw new GraphExecutionError(
      `Dagster run config exceeds the maximum nesting depth of ${DAGSTER_RUN_CONFIG_MAX_DEPTH}`,
      DAGSTER_ERROR.RUN_CONFIG_INVALID
    );
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = dagsterAllowlistedRunConfigValue(entry, depth + 1);
  }
  return result;
}

/**
 * Allowlists a single raw run config value, recursively. See
 * {@link dagsterAllowlistedRunConfig}.
 *
 * @param value - The value to allowlist.
 * @param depth - The current nesting depth.
 * @returns The allowlisted clone.
 * @throws {GraphExecutionError} `GRAPH_DAGSTER_RUN_CONFIG_INVALID` when the value
 *   is not JSON-safe.
 */
function dagsterAllowlistedRunConfigValue(value: unknown, depth: number): unknown {
  if (depth > DAGSTER_RUN_CONFIG_MAX_DEPTH) {
    throw new GraphExecutionError(
      `Dagster run config exceeds the maximum nesting depth of ${DAGSTER_RUN_CONFIG_MAX_DEPTH}`,
      DAGSTER_ERROR.RUN_CONFIG_INVALID
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GraphExecutionError(
        "Dagster run config contains a non-finite number",
        DAGSTER_ERROR.RUN_CONFIG_INVALID
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => dagsterAllowlistedRunConfigValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new GraphExecutionError(
        "Dagster run config contains a non-plain object",
        DAGSTER_ERROR.RUN_CONFIG_INVALID
      );
    }
    return dagsterAllowlistedRunConfig(
      value as Record<string, unknown>,
      depth
    );
  }
  throw new GraphExecutionError(
    "Dagster run config contains a non-JSON-safe value",
    DAGSTER_ERROR.RUN_CONFIG_INVALID
  );
}

/**
 * Maps one inspected Dagster op onto a canonical node instance. Port names and
 * asset keys travel as node metadata; no op body or Python source is carried.
 *
 * @param op - The inspected Dagster op.
 * @returns The canonical node instance.
 */
function dagsterNodeOf(op: DagsterJobOp): GraphNodeInstance {
  const metadata: Record<string, unknown> = { dagsterOpName: op.name };
  if (op.inputs) metadata["inputPorts"] = [...op.inputs];
  if (op.outputs) metadata["outputPorts"] = [...op.outputs];
  if (op.assetKeys) metadata["assetKeys"] = [...op.assetKeys];
  return {
    id: dagsterNodeIdOf(op),
    kind: op.kind ?? DAGSTER_DEFAULT_NODE_KIND,
    label: op.name,
    parameters: {},
    metadata: metadata as GraphNodeInstance["metadata"],
  };
}

/**
 * Maps the inspected job's op dependencies onto canonical edges. Each dependency
 * connects the upstream op's first declared output to the downstream op's first
 * declared input, falling back to stable default port names.
 *
 * @param job - The inspected Dagster job record.
 * @returns The canonical edge instances.
 */
function dagsterEdgesOf(job: DagsterJobRecord): GraphEdgeInstance[] {
  const byName = new Map<string, DagsterJobOp>();
  for (const op of job.ops ?? []) byName.set(op.name, op);
  const edges: GraphEdgeInstance[] = [];
  (job.dependencies ?? []).forEach((dependency, index) => {
    const from = byName.get(dependency.from);
    const to = byName.get(dependency.to);
    if (!from || !to) return;
    edges.push({
      id: `dagster_dep_${index}`,
      type: "data",
      source: {
        scope: "node",
        nodeId: dagsterNodeIdOf(from),
        port: from.outputs?.[0] ?? "result",
      },
      target: {
        scope: "node",
        nodeId: dagsterNodeIdOf(to),
        port: to.inputs?.[0] ?? "value",
      },
    });
  });
  return edges;
}

/**
 * Maps an inspected Dagster job record onto the canonical workflow document
 * shape. The deployment structure (job name, ops, dependencies, asset keys,
 * schedules/sensors) is carried as document metadata for read-only inspection;
 * nothing is authored.
 *
 * @param job - The inspected Dagster job record.
 * @returns The canonical workflow document.
 */
export function dagsterJobDocument(
  job: DagsterJobRecord
): GraphWorkflowDocument {
  const metadata: Record<string, unknown> = { dagsterJobName: job.name };
  if (job.description !== undefined) {
    metadata["description"] = job.description;
  }
  if (job.assetKeys !== undefined) {
    metadata["assetKeys"] = [...job.assetKeys];
  }
  if (job.schedules !== undefined) {
    metadata["schedules"] = job.schedules.map((schedule) => ({
      name: schedule.name,
      ...(schedule.cron !== undefined ? { cron: schedule.cron } : {}),
      ...(schedule.timezone !== undefined
        ? { timezone: schedule.timezone }
        : {}),
    }));
  }
  if (job.sensors !== undefined) {
    metadata["sensors"] = job.sensors.map((sensor) => ({
      name: sensor.name,
      ...(sensor.kind !== undefined ? { kind: sensor.kind } : {}),
    }));
  }
  return {
    id: job.name,
    name: job.name,
    inputs: [],
    outputs: [],
    nodes: (job.ops ?? []).map(dagsterNodeOf),
    edges: dagsterEdgesOf(job),
    metadata: metadata as GraphWorkflowDocument["metadata"],
  };
}

/** Internal input for {@link DagsterGraphExecutionBackend} run observation. */
interface DagsterObserveRunEventsInput {
  dagsterRunId: string;
  graphRunId: GraphRunId;
  workflowId: string;
  document: GraphWorkflowDocument;
  nodeIdsByOpName: Record<string, string>;
  events: GraphExecutionEventSink;
  inputs?: GraphExecutionValues;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  maxEvents?: number;
  maxPages?: number;
  terminalTimeoutMs?: number;
}

/**
 * Non-local Dagster backend. Read-only by default; launches/replays EXISTING
 * workflows only behind the explicit `executionEnabled` gate. Registers itself
 * under {@link DAGSTER_BACKEND_FLAVOUR} on construction.
 */
export class DagsterGraphExecutionBackend
  implements GraphExecutionBackend<DagsterGraphExecutionBackendConfig>
{
  /** This backend reads a remote Dagster deployment, not an in-process engine. */
  readonly local = false;

  /**
   * Dagster never authors code-mode surfaces; the facade rejects them before
   * delegating.
   */
  readonly codeMode = "unsupported" as const;

  private client?: DagsterClient;
  private readonly mapper = new DagsterResultMapper();
  private readonly bridges = new Map<string, DagsterGraphEventBridge>();
  /**
   * Read-only catalogue of seeded canonical documents. Seeding registers the
   * documents a host supplies at boot (its fixture registry) so they are listed
   * and looked up through this backend; it is NOT an authoring surface — the
   * backend's declared authoring capabilities stay `not_supported`.
   */
  private readonly seeded = new Map<string, GraphWorkflowDocument>();
  private defaultTags: Record<string, string> = {};
  private _config?: DagsterGraphExecutionBackendConfig;
  private executionEnabled = false;

  constructor() {
    GraphExecutionBackendRegistry.register(DAGSTER_BACKEND_FLAVOUR, this);
  }

  /**
   * Resolves the host-injected client port and the explicit execution gate. The
   * backend never reads a code sandbox evaluator.
   *
   * @param config - The backend configuration.
   */
  async initialize(
    config: DagsterGraphExecutionBackendConfig
  ): Promise<void> {
    this.client = config.client;
    this.defaultTags = config.tags ?? {};
    this.executionEnabled = config.executionEnabled === true;
    this._config = { ...config };
  }

  /**
   * The backend configuration most recently resolved by {@link initialize}. The
   * facade reads this during `GraphExecutionEngine.initialize` and merges its own
   * facade-owned keys over it, so a host that configured the backend directly
   * (including `executionEnabled`) before booting the engine does not lose that
   * wiring.
   */
  get config(): DagsterGraphExecutionBackendConfig | undefined {
    return this._config;
  }

  /**
   * Effective capability metadata: code-mode is `unsupported`; workflow
   * listing/lookup is supported exactly when the client port exposes it.
   */
  get capabilities(): GraphBackendCapabilities {
    const base = dagsterBackendCapabilities(this.client);
    // Seeded fixtures make listing/lookup available even without a wired client;
    // a wired client already declares the operations supported.
    if (this.seeded.size === 0) return base;
    return {
      ...base,
      workflows: { list: "supported", get: "supported" },
    };
  }

  /**
   * Lists the seeded fixture catalogue plus the deployment's Dagster jobs
   * through the client port. Seeded fixtures (owner-less, read-only) always
   * appear; deployment jobs are appended when a client port exposes job
   * listing, de-duplicated by id.
   *
   * @returns Real workflow summaries.
   * @throws {GraphExecutionError} when there is nothing to list: no seeded
   *   fixtures and the client port exposes no job listing.
   */
  async listWorkflows(): Promise<GraphBackendWorkflowSummary[]> {
    const seeded: GraphBackendWorkflowSummary[] = [
      ...this.seeded.values(),
    ].map((document) => ({
      id: document.id,
      ...(document.name ? { name: document.name } : {}),
    }));

    const client =
      this.client ?? (seeded.length > 0 ? undefined : this.requireClient());
    if (!client) return seeded;
    if (typeof client.listJobs !== "function") {
      if (seeded.length > 0) return seeded;
      throw new GraphExecutionError(
        "Dagster client port exposes no job listing; workflow listing is not supported",
        DAGSTER_ERROR.WORKFLOWS_NOT_SUPPORTED
      );
    }
    const jobs = await client.listJobs();
    const known = new Set(seeded.map((summary) => summary.id));
    const deploymentJobs = jobs
      .filter((job) => !known.has(job.name))
      .map((job) => ({
        id: job.name,
        name: job.name,
        ...(job.updatedAt !== undefined ? { updatedAt: job.updatedAt } : {}),
      }));
    return [...seeded, ...deploymentJobs];
  }

  /**
   * Seeds canonical workflow documents into this backend's read-only catalogue
   * so they are listed and looked up alongside the deployment's jobs. Seeding is
   * a host boot action, never an authoring surface: the backend's declared
   * authoring capabilities stay `not_supported`.
   *
   * @param documents - The canonical documents to register.
   * @returns The seeded workflow summaries.
   */
  async seedWorkflows(
    documents: readonly GraphWorkflowDocument[]
  ): Promise<GraphBackendWorkflowSummary[]> {
    const summaries: GraphBackendWorkflowSummary[] = [];
    for (const document of documents) {
      this.seeded.set(document.id, document);
      summaries.push({
        id: document.id,
        ...(document.name ? { name: document.name } : {}),
      });
    }
    return summaries;
  }

  /**
   * Reads a single already-deployed Dagster job through the client port and maps
   * its ACTUAL deployment structure (graph/op structure, asset keys,
   * schedules/sensors) into the canonical document shape.
   *
   * @param workflowId - The canonical workflow id (the Dagster job name).
   * @returns A canonical document describing the existing job.
   * @throws {GraphExecutionError} when the client port exposes no job lookup.
   */
  async getWorkflow(workflowId: string): Promise<GraphWorkflowDocument> {
    const seeded = this.seeded.get(workflowId);
    if (seeded) return seeded;
    const client = this.requireClient();
    if (typeof client.getJob !== "function") {
      throw new GraphExecutionError(
        "Dagster client port exposes no job lookup; workflow lookup is not supported",
        DAGSTER_ERROR.WORKFLOWS_NOT_SUPPORTED
      );
    }
    const job = await client.getJob(workflowId);
    return dagsterJobDocument(job);
  }

  /**
   * Reads an EXISTING Dagster run's terminal record through the client port.
   *
   * @param runId - The Dagster run id.
   * @returns The terminal run record.
   */
  async getRun(runId: string): Promise<DagsterRunRecord> {
    return await this.requireClient().getRun(runId);
  }

  /**
   * Observes an EXISTING Dagster run: subscribes to its event stream, maps every
   * event onto the canonical sink, and returns the canonical result of the terminal
   * record. The driver never launches the run; the caller supplies the id of a run
   * that already exists in the deployment.
   *
   * The request's bounds (`signal`, `maxEvents`, `maxPages`, `terminalTimeoutMs`)
   * are forwarded to the event bridge so the observation always terminates: the
   * event cap fails closed with `GRAPH_DAGSTER_EVENT_LIMIT_EXCEEDED`, the terminal
   * wait with `GRAPH_DAGSTER_OBSERVE_TIMEOUT`, and an abort with
   * `GRAPH_DAGSTER_OBSERVE_ABORTED`.
   *
   * @param request - The observe request (existing run id, workflow id, sink, and
   *   optional observation bounds).
   * @returns The canonical execution result of the observed run.
   * @throws {GraphExecutionError} when the run cannot be read or subscribed to,
   *   or when an observation bound is hit (see above).
   */
  async observeRun(
    request: DagsterObserveRunRequest
  ): Promise<GraphExecutionResult> {
    const client = this.requireClient();
    const job = await client.getJob(request.workflowId);
    const document = dagsterJobDocument(job);
    const graphRunId: GraphRunId = request.graphRunId ?? request.dagsterRunId;
    return await this.observeRunEvents({
      dagsterRunId: request.dagsterRunId,
      graphRunId,
      workflowId: request.workflowId,
      document,
      nodeIdsByOpName: dagsterNodeIdsByOpName(job),
      events: request.events,
      ...(request.inputs !== undefined ? { inputs: request.inputs } : {}),
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.maxEvents !== undefined
        ? { maxEvents: request.maxEvents }
        : {}),
      ...(request.maxPages !== undefined ? { maxPages: request.maxPages } : {}),
      ...(request.terminalTimeoutMs !== undefined
        ? { terminalTimeoutMs: request.terminalTimeoutMs }
        : {}),
    });
  }

  /**
   * Executes an ALREADY-DEPLOYED Dagster job: launches a run of the job the
   * supplied document describes through the client port's `launchRun`, then
   * observes it through the existing event bridge to a canonical result.
   *
   * The operation is gated: when `executionEnabled` is off it fails closed with
   * `GRAPH_DAGSTER_EXECUTION_NOT_ENABLED` BEFORE any network call, and when the
   * client port exposes no `launchRun` it fails closed with
   * `GRAPH_DAGSTER_EXECUTION_NOT_SUPPORTED`. The driver never translates a
   * document into Python; it launches a job the deployment already defines.
   *
   * The job is bound from the document's canonical workflow id and confirmed
   * through the read-only `getJob` surface, never from the document's untrusted
   * `metadata.dagsterJobName` (C2): a document whose metadata names a different
   * job is rejected before any launch.
   *
   * @param request - The execution request (document, plan, inputs, options, sink).
   * @returns The canonical execution result of the launched run.
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_EXECUTION_NOT_ENABLED` when the
   *   gate is off, `GRAPH_DAGSTER_EXECUTION_NOT_SUPPORTED` when the port exposes no
   *   launch, `GRAPH_DAGSTER_RUN_WORKFLOW_MISMATCH` when the document metadata
   *   names a different job, or `GRAPH_DAGSTER_RUN_LAUNCH_FAILED` when the launch
   *   fails.
   */
  async execute(
    request: GraphBackendExecutionRequest
  ): Promise<GraphExecutionResult> {
    this.assertExecutionEnabled();
    const client = this.requireClient();
    if (typeof client.launchRun !== "function") {
      throw new GraphExecutionError(
        "Dagster client port exposes no launchRun; executing an existing workflow is not supported",
        DAGSTER_ERROR.EXECUTION_NOT_SUPPORTED
      );
    }
    const document = request.document;
    const workflowId = dagsterCanonicalWorkflowIdOf(document);
    const jobName = await this.resolveCanonicalJobName(
      client,
      workflowId,
      document
    );
    const graphRunId: GraphRunId =
      request.options.runId ?? `dagster-${workflowId}-${Date.now()}`;
    const runConfig = this.dagsterRunConfigOf(request.options.metadata);
    const launched = await this.launchThroughPort(client, {
      jobName,
      graphRunId,
      workflowId,
      ...(runConfig ? { runConfig } : {}),
    });
    await this.awaitRunTerminal(client, launched.runId, {
      ...(request.options.abortSignal
        ? { signal: request.options.abortSignal }
        : {}),
    });
    return await this.observeRunEvents({
      dagsterRunId: launched.runId,
      graphRunId,
      workflowId,
      document,
      nodeIdsByOpName: dagsterNodeIdsByOpNameFromDocument(document),
      events: request.events,
      inputs: request.inputs,
      ...(request.options.metadata !== undefined
        ? { metadata: request.options.metadata }
        : {}),
    });
  }

  /**
   * Replays (re-executes) an EXISTING Dagster run through the client port's
   * `replayRun`, then observes the new run through the existing event bridge to a
   * canonical result.
   *
   * The operation is gated: when `executionEnabled` is off it fails closed with
   * `GRAPH_DAGSTER_EXECUTION_NOT_ENABLED` BEFORE any network call, and when the
   * client port exposes no `replayRun` it fails closed with
   * `GRAPH_DAGSTER_REPLAY_NOT_SUPPORTED`. The re-execution mechanism (GraphQL
   * re-execution from the run id, or a re-launch of the run's job with its original
   * configuration) is owned by the host transport; the driver only observes the
   * resulting run.
   *
   * The caller-supplied run id is bound to the requested workflow before any
   * re-execution (C1): the run's owning job is resolved through the read-only
   * `getRun` surface and a cross-job replay, or a run whose owning job cannot be
   * determined, is rejected before the re-execution is issued.
   *
   * @param request - The replay request (existing run id, workflow id, sink, bounds).
   * @returns The canonical execution result of the re-executed run.
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_EXECUTION_NOT_ENABLED` when the
   *   gate is off, `GRAPH_DAGSTER_REPLAY_NOT_SUPPORTED` when the port exposes no
   *   replay, `GRAPH_DAGSTER_RUN_WORKFLOW_MISMATCH` when the run does not belong
   *   to the requested workflow, or `GRAPH_DAGSTER_RUN_LAUNCH_FAILED` when the
   *   re-execution fails.
   */
  async replayRun(
    request: DagsterReplayExistingRunRequest
  ): Promise<GraphExecutionResult> {
    this.assertExecutionEnabled();
    const client = this.requireClient();
    if (typeof client.replayRun !== "function") {
      throw new GraphExecutionError(
        "Dagster client port exposes no replayRun; replaying an existing run is not supported",
        DAGSTER_ERROR.REPLAY_NOT_SUPPORTED
      );
    }
    await this.assertRunOwnedByWorkflow(
      client,
      request.dagsterRunId,
      request.workflowId
    );
    const job = await client.getJob(request.workflowId);
    const document = dagsterJobDocument(job);
    const graphRunId: GraphRunId =
      request.graphRunId ?? `dagster-replay-${request.dagsterRunId}`;
    const launched = await this.replayThroughPort(client, {
      dagsterRunId: request.dagsterRunId,
      jobName: request.workflowId,
      graphRunId,
      workflowId: request.workflowId,
    });
    await this.awaitRunTerminal(client, launched.runId, {
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.terminalTimeoutMs !== undefined
        ? { timeoutMs: request.terminalTimeoutMs }
        : {}),
    });
    return await this.observeRunEvents({
      dagsterRunId: launched.runId,
      graphRunId,
      workflowId: request.workflowId,
      document,
      nodeIdsByOpName: dagsterNodeIdsByOpName(job),
      events: request.events,
      ...(request.inputs !== undefined ? { inputs: request.inputs } : {}),
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.maxEvents !== undefined
        ? { maxEvents: request.maxEvents }
        : {}),
      ...(request.maxPages !== undefined ? { maxPages: request.maxPages } : {}),
      ...(request.terminalTimeoutMs !== undefined
        ? { terminalTimeoutMs: request.terminalTimeoutMs }
        : {}),
    });
  }

  /**
   * Terminates an EXISTING run through the client port.
   *
   * @param runId - The Dagster run id.
   * @param reason - Optional cancellation reason.
   * @returns `true` when a run was terminated.
   */
  async cancel(runId: GraphRunId, reason?: string): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    await client.terminateRun(runId, reason);
    return true;
  }

  /**
   * Releases the bridge resources associated with a run.
   *
   * @param runId - The canonical run id.
   */
  async release(runId: GraphRunId): Promise<void> {
    const bridge = this.bridges.get(runId);
    if (!bridge) return;
    await bridge.stop();
    this.bridges.delete(runId);
  }

  /** Disposes the backend and the host-injected client port. */
  async dispose(): Promise<void> {
    for (const bridge of this.bridges.values()) {
      await bridge.stop();
    }
    this.bridges.clear();
    await this.client?.dispose?.();
  }

  /**
   * Subscribes to an EXISTING (or just-launched) run's event stream, maps every
   * event onto the canonical sink, and returns the canonical result of the
   * terminal record. Shared by `observeRun`, `execute`, and `replayRun`.
   *
   * @param input - The run identity, document, op map, sink, and observation bounds.
   * @returns The canonical execution result.
   * @throws {GraphExecutionError} when the run cannot be read or subscribed to, or
   *   when an observation bound is hit.
   */
  private async observeRunEvents(
    input: DagsterObserveRunEventsInput
  ): Promise<GraphExecutionResult> {
    const client = this.requireClient();
    const bridge = new DagsterGraphEventBridge({
      dagsterRunId: input.dagsterRunId,
      graphRunId: input.graphRunId,
      workflowId: input.workflowId,
      nodeIdsByOpName: input.nodeIdsByOpName,
      sink: input.events,
      client,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.maxEvents !== undefined ? { maxEvents: input.maxEvents } : {}),
      ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
      ...(input.terminalTimeoutMs !== undefined
        ? { terminalTimeoutMs: input.terminalTimeoutMs }
        : {}),
    });
    this.bridges.set(input.graphRunId, bridge);

    try {
      await bridge.start();
      const record = await bridge.waitForTerminal();
      return this.mapper.map({
        runId: input.graphRunId,
        document: input.document,
        inputs: input.inputs ?? {},
        options: { runId: input.graphRunId, metadata: input.metadata },
        record,
        nodeResults: bridge.collectedNodeResults(),
        events: [],
      });
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        error instanceof Error ? error.message : String(error),
        DAGSTER_ERROR.RUN_FAILED,
        { runId: input.graphRunId }
      );
    } finally {
      await bridge.stop();
      this.bridges.delete(input.graphRunId);
    }
  }

  /**
   * Launches a run through the port, mapping any transport failure onto the
   * driver's machine-readable launch error.
   *
   * @param client - The wired client port.
   * @param input - The job name, canonical run id, workflow id, and run config.
   * @returns The launched run handle.
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_RUN_LAUNCH_FAILED`.
   */
  private async launchThroughPort(
    client: DagsterClient,
    input: {
      jobName: string;
      graphRunId: string;
      workflowId: string;
      runConfig?: Record<string, unknown>;
    }
  ): Promise<DagsterLaunchedRun> {
    try {
      return await client.launchRun!({
        jobName: input.jobName,
        ...(input.runConfig ? { runConfig: input.runConfig } : {}),
        tags: this.executionTags(input.graphRunId, input.workflowId),
      });
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        error instanceof Error ? error.message : String(error),
        DAGSTER_ERROR.RUN_LAUNCH_FAILED,
        { jobName: input.jobName, runId: input.graphRunId }
      );
    }
  }

  /**
   * Re-executes an existing run through the port, mapping any transport failure
   * onto the driver's machine-readable launch error.
   *
   * @param client - The wired client port.
   * @param input - The existing run id, job name, canonical run id, workflow id.
   * @returns The re-executed run handle.
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_RUN_LAUNCH_FAILED`.
   */
  private async replayThroughPort(
    client: DagsterClient,
    input: {
      dagsterRunId: string;
      jobName: string;
      graphRunId: string;
      workflowId: string;
    }
  ): Promise<DagsterLaunchedRun> {
    try {
      return await client.replayRun!({
        dagsterRunId: input.dagsterRunId,
        jobName: input.jobName,
        tags: this.executionTags(input.graphRunId, input.workflowId),
      });
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        error instanceof Error ? error.message : String(error),
        DAGSTER_ERROR.RUN_LAUNCH_FAILED,
        { runId: input.graphRunId }
      );
    }
  }

  /**
   * Resolves the canonical deployed job a requested workflow binds to and rejects
   * any document whose untrusted `metadata.dagsterJobName` claims a different job
   * BEFORE any launch (C2). The canonical id comes from the document's own
   * identity and is confirmed through the read-only `getJob` surface, mirroring
   * `replayRun`; an unknown workflow fails closed as a launch failure.
   *
   * @param client - The wired client port.
   * @param workflowId - The canonical workflow id (the document's own identity).
   * @param document - The canonical document whose metadata must agree.
   * @returns The canonical deployed job name to launch.
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_RUN_WORKFLOW_MISMATCH` when the
   *   metadata names a different job, or `GRAPH_DAGSTER_RUN_LAUNCH_FAILED` when the
   *   canonical job cannot be resolved.
   */
  private async resolveCanonicalJobName(
    client: DagsterClient,
    workflowId: string,
    document: GraphWorkflowDocument
  ): Promise<string> {
    const claimed = document.metadata?.["dagsterJobName"];
    if (
      typeof claimed === "string" &&
      claimed.length > 0 &&
      claimed !== workflowId
    ) {
      throw new GraphExecutionError(
        `Workflow document '${workflowId}' declares a different Dagster job ('${claimed}'); refusing to launch a mismatched job`,
        DAGSTER_ERROR.RUN_WORKFLOW_MISMATCH,
        { workflowId, claimedJobName: claimed }
      );
    }
    try {
      const job = await client.getJob(workflowId);
      return job.name || workflowId;
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        error instanceof Error ? error.message : String(error),
        DAGSTER_ERROR.RUN_LAUNCH_FAILED,
        { jobName: workflowId }
      );
    }
  }

  /**
   * Asserts that a caller-supplied Dagster run id belongs to the requested
   * workflow before it is re-executed (C1 BOLA guard). The run's owning job is
   * resolved from the read-only `getRun` surface; a cross-job run, or a run whose
   * owning job cannot be determined, is rejected before any re-execution.
   *
   * @param client - The wired client port.
   * @param dagsterRunId - The caller-supplied run id to bind.
   * @param workflowId - The workflow the run must belong to.
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_RUN_WORKFLOW_MISMATCH` when the
   *   run is foreign or its owning job cannot be determined.
   */
  private async assertRunOwnedByWorkflow(
    client: DagsterClient,
    dagsterRunId: string,
    workflowId: string
  ): Promise<void> {
    let record: DagsterRunRecord;
    try {
      record = await client.getRun(dagsterRunId);
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Dagster run '${dagsterRunId}' could not be read to bind it to workflow '${workflowId}'`,
        DAGSTER_ERROR.RUN_WORKFLOW_MISMATCH,
        { runId: dagsterRunId, workflowId }
      );
    }
    const owner = record.jobName ?? record.pipelineName;
    if (typeof owner !== "string" || owner.length === 0 || owner !== workflowId) {
      throw new GraphExecutionError(
        `Dagster run '${dagsterRunId}' does not belong to workflow '${workflowId}'`,
        DAGSTER_ERROR.RUN_WORKFLOW_MISMATCH,
        { runId: dagsterRunId, workflowId, ...(owner ? { owner } : {}) }
      );
    }
  }

  /**
   * Awaits a launched/re-executed run's terminal state through the read-only
   * `getRun` surface, bounded by the signal and timeout. The run is then observed
   * through the event bridge; this keeps the transport's replay-based subscription
   * (which does not stream) sufficient without a live transport.
   *
   * @param client - The wired client port.
   * @param runId - The launched/re-executed Dagster run id.
   * @param options - Optional signal, timeout, and poll interval.
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_OBSERVE_ABORTED` on abort, or
   *   `GRAPH_DAGSTER_OBSERVE_TIMEOUT` when the run does not terminate in time.
   */
  private async awaitRunTerminal(
    client: DagsterClient,
    runId: string,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {}
  ): Promise<void> {
    const timeoutMs =
      options.timeoutMs ?? DEFAULT_EXECUTION_TERMINAL_TIMEOUT_MS;
    const pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_EXECUTION_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (options.signal?.aborted) {
        throw new GraphExecutionError(
          `Dagster run '${runId}' wait was aborted by the caller`,
          DAGSTER_ERROR.OBSERVE_ABORTED,
          { runId }
        );
      }
      const record = await client.getRun(runId);
      if (DAGSTER_TERMINAL_RUN_STATUSES.has(record.status)) return;
      if (Date.now() >= deadline) {
        throw new GraphExecutionError(
          `Dagster run '${runId}' did not reach a terminal state within ${timeoutMs}ms`,
          DAGSTER_ERROR.OBSERVE_TIMEOUT,
          { runId, timeoutMs }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /**
   * Fails closed when the explicit execution gate is off, BEFORE any client or
   * network call.
   *
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_EXECUTION_NOT_ENABLED`.
   */
  private assertExecutionEnabled(): void {
    if (!this.executionEnabled) {
      throw new GraphExecutionError(
        "Dagster execution is disabled: set `executionEnabled: true` on the backend config to execute or replay EXISTING workflows",
        DAGSTER_ERROR.EXECUTION_NOT_ENABLED
      );
    }
  }

  /**
   * Builds the run tags the driver attaches to a launched/re-executed run: the
   * host defaults plus the canonical run/workflow identity under the
   * {@link DAGSTER_TAG_NAMESPACE} namespace. No document content or Python source
   * is carried.
   *
   * @param graphRunId - The canonical run id.
   * @param workflowId - The canonical workflow id.
   * @returns The run tags.
   */
  private executionTags(
    graphRunId: string,
    workflowId: string
  ): Record<string, string> {
    return {
      ...this.defaultTags,
      [`${DAGSTER_TAG_NAMESPACE}graphRunId`]: graphRunId,
      [`${DAGSTER_TAG_NAMESPACE}workflowId`]: workflowId,
    };
  }

  /**
   * Reads the optional raw Dagster run configuration from execution metadata. The
   * driver forwards it verbatim; it never synthesizes run config.
   *
   * @param metadata - The execution options metadata.
   * @returns The raw run config, when present.
   */
  private dagsterRunConfigOf(
    metadata?: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    const runConfig = metadata?.["dagsterRunConfig"];
    if (runConfig === undefined || runConfig === null) return undefined;
    if (typeof runConfig !== "object" || Array.isArray(runConfig)) {
      throw new GraphExecutionError(
        "Dagster run config must be a JSON-safe object",
        DAGSTER_ERROR.RUN_CONFIG_INVALID
      );
    }
    return dagsterAllowlistedRunConfig(
      runConfig as Record<string, unknown>,
      0
    );
  }

  /**
   * Returns the wired client port or fails loudly.
   *
   * @returns The client port.
   * @throws {GraphExecutionError} when no client is configured.
   */
  private requireClient(): DagsterClient {
    if (!this.client) {
      throw new GraphExecutionError(
        "DagsterGraphExecutionBackend has no client configured; call initialize(config) first",
        DAGSTER_ERROR.CLIENT_NOT_CONFIGURED
      );
    }
    return this.client;
  }
}
