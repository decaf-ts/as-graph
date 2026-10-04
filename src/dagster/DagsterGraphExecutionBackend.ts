/**
 * @module as-graph/dagster/DagsterGraphExecutionBackend
 * @summary Dagster graph execution backend (SAA-195, DECAF-50 §4.9).
 * @description A non-local {@link GraphExecutionBackend} that translates the
 * canonical workflow document into a Dagster job artifact and drives a
 * host-injected {@link DagsterClient} port. The backend:
 *
 * - declares `local = false` and `codeMode = "unsupported"`, so the facade fails
 *   closed on any code-mode surface before launch (SAA-193 C1/C2);
 * - never reads, sets, or reconfigures a code sandbox evaluator (SAA-193 C3);
 * - reports every transition through the facade-owned
 *   {@link GraphExecutionEventSink}, which remains the single sequencing authority.
 */
import type { GraphWorkflowDocument } from "../shared/graph";
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
import { DAGSTER_BACKEND_FLAVOUR, DAGSTER_ERROR } from "./constants";
import type {
  DagsterClient,
  DagsterGraphExecutionBackendConfig,
} from "./DagsterTypes";
import { dagsterBackendCapabilities } from "./capabilities";
import { DagsterWorkflowTranslator } from "./DagsterWorkflowTranslator";
import { DagsterGraphEventBridge } from "./DagsterGraphEventBridge";
import { DagsterResultMapper } from "./DagsterResultMapper";

/**
 * Non-local Dagster execution backend. Registers itself under
 * {@link DAGSTER_BACKEND_FLAVOUR} on construction.
 */
export class DagsterGraphExecutionBackend
  implements GraphExecutionBackend<DagsterGraphExecutionBackendConfig>
{
  /** This backend executes remotely in Dagster, not in-process. */
  readonly local = false;

  /**
   * Dagster cannot execute code-mode surfaces; the facade rejects them before
   * launch (SAA-193 C1/C2).
   */
  readonly codeMode = "unsupported" as const;

  private client?: DagsterClient;
  private translator!: DagsterWorkflowTranslator;
  private readonly mapper = new DagsterResultMapper();
  private readonly bridges = new Map<string, DagsterGraphEventBridge>();
  private defaultTags: Record<string, string> = {};

  constructor() {
    GraphExecutionBackendRegistry.register(DAGSTER_BACKEND_FLAVOUR, this);
  }

  /**
   * Resolves the host-injected client port and op resolver. The backend never
   * reads a code sandbox evaluator (SAA-193 C3).
   *
   * @param config - The backend configuration.
   */
  async initialize(
    config: DagsterGraphExecutionBackendConfig
  ): Promise<void> {
    this.client = config.client;
    this.defaultTags = config.tags ?? {};
    this.translator = new DagsterWorkflowTranslator({
      opResolver: config.opResolver,
    });
  }

  /**
   * Effective capability metadata: code-mode is `unsupported`; workflow
   * listing/lookup is supported exactly when the client port exposes it
   * (Deliverable 4 addendum).
   */
  get capabilities(): GraphBackendCapabilities {
    return dagsterBackendCapabilities(this.client);
  }

  /**
   * Lists deployed Dagster jobs through the client port, when supported.
   *
   * @returns Workflow summaries.
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
   * Reads a single deployed Dagster job through the client port, when supported.
   *
   * @param workflowId - The canonical workflow id.
   * @returns A canonical document for the job.
   * @throws {GraphExecutionError} when the client port exposes no job lookup.
   */
  async getWorkflow(
    workflowId: string
  ): Promise<GraphWorkflowDocument> {
    const client = this.requireClient();
    if (typeof client.getJob !== "function") {
      throw new GraphExecutionError(
        "Dagster client port exposes no job lookup; workflow lookup is not supported",
        DAGSTER_ERROR.WORKFLOWS_NOT_SUPPORTED
      );
    }
    const job = await client.getJob(workflowId);
    return {
      id: job.name,
      name: job.name,
      inputs: [],
      outputs: [],
      nodes: [],
      edges: [],
    };
  }

  /**
   * Translates the canonical document and drives the Dagster run, reporting every
   * transition through the request's facade-owned sink.
   *
   * @param request - The execution request.
   * @returns The canonical execution result.
   * @throws {GraphExecutionError} on code-mode surfaces, unmapped kinds, invalid
   *   condition paths, non-JSON-safe values, or a missing client port.
   */
  async execute(
    request: GraphBackendExecutionRequest
  ): Promise<GraphExecutionResult> {
    const client = this.requireClient();
    const artifact = this.translator.translate(request.document);
    const runId: GraphRunId = request.options.runId ?? request.document.id;

    const handle = await client.launchRun({
      jobName: artifact.jobName,
      runConfig: artifact.runConfig,
      tags: { ...this.defaultTags, ...artifact.tags },
      documentFingerprint: artifact.fingerprint,
      workflowId: artifact.workflowId,
    });

    const bridge = new DagsterGraphEventBridge({
      dagsterRunId: handle.runId,
      graphRunId: runId,
      workflowId: artifact.workflowId,
      artifact,
      sink: request.events,
      client,
    });
    this.bridges.set(runId, bridge);

    try {
      await bridge.start();
      const record = await bridge.waitForTerminal();
      return this.mapper.map({
        runId,
        document: request.document,
        inputs: request.inputs,
        options: request.options,
        record,
        nodeResults: bridge.collectedNodeResults(),
        events: [],
      });
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        error instanceof Error ? error.message : String(error),
        DAGSTER_ERROR.RUN_FAILED,
        { runId }
      );
    } finally {
      await bridge.stop();
      this.bridges.delete(runId);
    }
  }

  /**
   * Cancels a run through the client port.
   *
   * @param runId - The canonical run id.
   * @param reason - Optional cancellation reason.
   * @returns `true` when a run was cancelled.
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
