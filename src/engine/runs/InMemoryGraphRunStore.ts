import type { GraphRun, GraphRunStore } from "./types";
import type { GraphRunModel } from "../../shared/graph";
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
}
