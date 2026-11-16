import {
  GRAPH_RUN_ACTIVE_STATUSES,
  type GraphRun,
  type GraphRunPruneQuery,
  type GraphRunRetentionEntry,
  type GraphRunStore,
} from "./types";
import { isGraphRunTerminalStatus, type GraphRunModel } from "../../shared/graph";
import { runToModel } from "./GraphRunConverters";

/**
 * Non-persistent {@link GraphRunStore} backed by a `Map`: serves tests and
 * in-process deployments. Runs are cloned on save/read so callers never
 * share mutable references with the store.
 */
export class InMemoryGraphRunStore implements GraphRunStore {
  private readonly runs = new Map<string, GraphRun>();

  /**
   * Clones and stores the run by its id (upsert semantics).
   *
   * @param {GraphRun} run - Engine-side run to persist.
   * @return {Promise<void>} Resolves once the run is stored.
   */
  async saveRun(run: GraphRun): Promise<void> {
    this.runs.set(run.runId, { ...run });
  }

  /**
   * Reads a run and returns a clone, so callers never share mutable
   * references with the store.
   *
   * @param {string} runId - Id of the run to read.
   * @return {Promise<GraphRun | null>} The run, or `null` when no row exists.
   */
  async readRun(runId: string): Promise<GraphRun | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  /**
   * Lists every in-memory run that executed the given workflow, converted to
   * its persisted {@link GraphRunModel} shape so the serving list keeps the
   * storage-derived fields (`updatedAt`, `inputs`). Unordered; the run
   * service orders the serving result.
   *
   * @param {string} workflowId - Workflow document id the runs executed.
   * @return {Promise<GraphRunModel[]>} The matching rows (empty when none exist).
   */
  async listRuns(workflowId: string): Promise<GraphRunModel[]> {
    return [...this.runs.values()]
      .filter((run) => run.workflowId === workflowId)
      .map((run) => runToModel(run));
  }

  /**
   * Deletes a run's row, mirroring the event-store `release?` contract.
   *
   * @param {string} runId - Id of the run to release.
   */
  release(runId: string): void {
    this.runs.delete(runId);
  }

  /**
   * One batch of prunable finished runs (see {@link GraphRunStore.listPrunableRuns}).
   *
   * @return {Promise<GraphRunRetentionEntry[]>} The batch.
   */
  async listPrunableRuns(query: GraphRunPruneQuery): Promise<GraphRunRetentionEntry[]> {
    const at = (run: GraphRun) => new Date(run.finishedAt ?? run.createdAt).getTime();
    const finished = [...this.runs.values()].filter((run) =>
      isGraphRunTerminalStatus(run.status)
    );
    const ordered =
      query.before !== undefined
        ? finished
            .filter((run) => at(run) < (query.before as Date).getTime())
            .sort((a, b) => at(a) - at(b))
        : finished.sort((a, b) => at(b) - at(a)).slice(query.keepNewest ?? 0);
    return ordered.slice(0, query.limit).map((run) => ({
      runId: run.runId,
      status: run.status,
      createdAt: new Date(run.createdAt),
      ...(run.finishedAt ? { finishedAt: new Date(run.finishedAt) } : {}),
    }));
  }

  /**
   * Deletes a run (no-op for an unknown id).
   *
   * @param {string} runId - Id of the run to delete.
   * @return {Promise<void>} Resolves once the run is gone.
   */
  async deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  async listStaleRuns(query: { before: Date; includeQueued: boolean }): Promise<GraphRun[]> {
    return [...this.runs.values()]
      .filter((run) => (GRAPH_RUN_ACTIVE_STATUSES as readonly string[]).includes(run.status))
      .filter((run) => query.includeQueued || run.status !== "queued")
      .filter((run) => !run.suspendedAt)
      .filter((run) => {
        const beat = run.heartbeatAt ?? run.startedAt ?? run.createdAt;
        return new Date(beat).getTime() < query.before.getTime();
      })
      .map((run) => ({ ...run }));
  }

  async heartbeat(runId: string, workerId: string, at: Date): Promise<void> {
    const run = this.runs.get(runId);
    if (run) this.runs.set(runId, { ...run, workerId, heartbeatAt: at.toISOString() });
  }

  async countActiveRuns(callerKey: string): Promise<number> {
    return [...this.runs.values()].filter(
      (run) =>
        run.callerKey === callerKey &&
        (GRAPH_RUN_ACTIVE_STATUSES as readonly string[]).includes(run.status)
    ).length;
  }

  async countRunsSince(callerKey: string, since: Date): Promise<number> {
    return [...this.runs.values()].filter(
      (run) => run.callerKey === callerKey && new Date(run.createdAt) >= since
    ).length;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<GraphRun | null> {
    const run = [...this.runs.values()].find((r) => r.idempotencyKey === idempotencyKey);
    return run ? { ...run } : null;
  }

  async sumStoredBytes(callerKey: string): Promise<number> {
    return [...this.runs.values()]
      .filter((run) => run.callerKey === callerKey)
      .reduce((total, run) => total + (run.storedBytes ?? 0), 0);
  }
}
