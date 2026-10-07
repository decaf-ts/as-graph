/**
 * @module as-graph/dagster/DagsterGraphExecutionBackend
 * @summary Read-only Dagster graph backend (DECAF-50 §4.9).
 * @description A non-local {@link GraphExecutionBackend} that only lists, looks
 * up, and inspects ALREADY-EXISTING Dagster workflows through a host-injected
 * {@link DagsterClient} port. By owner mandate the driver never authors a
 * workflow and never generates, embeds, or emits Python source:
 *
 * - `execute` fails closed with `GRAPH_DAGSTER_AUTHORING_NOT_SUPPORTED`; no run is
 *   launched from a translated document and no `launchRun` call exists;
 * - `listWorkflows`/`getWorkflow` map the real deployment structure (job name,
 *   graph/op structure, asset keys, schedules/sensors) into the canonical summary
 *   and document shapes;
 * - `observeRun` surfaces the events of an EXISTING run and maps its terminal
 *   record onto a canonical result;
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
} from "../engine/execution/GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../engine/execution/GraphExecutionBackendRegistry";
import type {
  GraphExecutionResult,
  GraphRunId,
} from "../engine/types";
import {
  DAGSTER_BACKEND_FLAVOUR,
  DAGSTER_DEFAULT_NODE_KIND,
  DAGSTER_ERROR,
} from "./constants";
import type {
  DagsterClient,
  DagsterGraphExecutionBackendConfig,
  DagsterJobOp,
  DagsterJobRecord,
  DagsterObserveRunRequest,
  DagsterRunRecord,
} from "./DagsterTypes";
import { dagsterBackendCapabilities } from "./capabilities";
import { DagsterGraphEventBridge } from "./DagsterGraphEventBridge";
import { DagsterResultMapper } from "./DagsterResultMapper";

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

/**
 * Non-local, read-only Dagster backend. Registers itself under
 * {@link DAGSTER_BACKEND_FLAVOUR} on construction.
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
  private defaultTags: Record<string, string> = {};

  constructor() {
    GraphExecutionBackendRegistry.register(DAGSTER_BACKEND_FLAVOUR, this);
  }

  /**
   * Resolves the host-injected, read-only client port. The backend never reads a
   * code sandbox evaluator.
   *
   * @param config - The backend configuration.
   */
  async initialize(
    config: DagsterGraphExecutionBackendConfig
  ): Promise<void> {
    this.client = config.client;
    this.defaultTags = config.tags ?? {};
  }

  /**
   * Effective capability metadata: code-mode is `unsupported`; workflow
   * listing/lookup is supported exactly when the client port exposes it.
   */
  get capabilities(): GraphBackendCapabilities {
    return dagsterBackendCapabilities(this.client);
  }

  /**
   * Lists the deployment's Dagster jobs through the client port.
   *
   * @returns Real workflow summaries.
   * @throws {GraphExecutionError} when the client port exposes no job listing.
   */
  async listWorkflows(): Promise<GraphBackendWorkflowSummary[]> {
    const client = this.requireClient();
    if (typeof client.listJobs !== "function") {
      throw new GraphExecutionError(
        "Dagster client port exposes no job listing; workflow listing is not supported",
        DAGSTER_ERROR.WORKFLOWS_NOT_SUPPORTED
      );
    }
    const jobs = await client.listJobs();
    return jobs.map((job) => ({
      id: job.name,
      name: job.name,
      ...(job.updatedAt !== undefined ? { updatedAt: job.updatedAt } : {}),
    }));
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
    const bridge = new DagsterGraphEventBridge({
      dagsterRunId: request.dagsterRunId,
      graphRunId,
      workflowId: request.workflowId,
      nodeIdsByOpName: dagsterNodeIdsByOpName(job),
      sink: request.events,
      client,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.maxEvents !== undefined
        ? { maxEvents: request.maxEvents }
        : {}),
      ...(request.maxPages !== undefined ? { maxPages: request.maxPages } : {}),
      ...(request.terminalTimeoutMs !== undefined
        ? { terminalTimeoutMs: request.terminalTimeoutMs }
        : {}),
    });
    this.bridges.set(graphRunId, bridge);

    try {
      await bridge.start();
      const record = await bridge.waitForTerminal();
      return this.mapper.map({
        runId: graphRunId,
        document,
        inputs: request.inputs ?? {},
        options: { runId: graphRunId, metadata: request.metadata },
        record,
        nodeResults: bridge.collectedNodeResults(),
        events: [],
      });
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        error instanceof Error ? error.message : String(error),
        DAGSTER_ERROR.RUN_FAILED,
        { runId: graphRunId }
      );
    } finally {
      await bridge.stop();
      this.bridges.delete(graphRunId);
    }
  }

  /**
   * Rejects workflow authoring. The Dagster driver is read-only by owner mandate:
   * it never accepts a translated document and never launches a run.
   *
   * @param _request - The execution request (ignored).
   * @throws {GraphExecutionError} always, with
   *   `GRAPH_DAGSTER_AUTHORING_NOT_SUPPORTED`.
   */
  async execute(
    _request: GraphBackendExecutionRequest
  ): Promise<GraphExecutionResult> {
    void _request;
    throw new GraphExecutionError(
      "DagsterGraphExecutionBackend is read-only: it lists, looks up, and inspects existing Dagster workflows, but never authors or launches one",
      DAGSTER_ERROR.AUTHORING_NOT_SUPPORTED
    );
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
