import type { GraphRun, GraphRunStore } from "./types";

/**
 * Non-persistent {@link GraphRunStore} backed by a `Map`: serves tests and
 * in-process deployments. Runs are cloned on save/read so callers never
 * share mutable references with the store.
 */
export class InMemoryGraphRunStore implements GraphRunStore {
  private readonly runs = new Map<string, GraphRun>();

  async saveRun(run: GraphRun): Promise<void> {
    this.runs.set(run.runId, { ...run });
  }

  async readRun(runId: string): Promise<GraphRun | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  release(runId: string): void {
    this.runs.delete(runId);
  }
}
