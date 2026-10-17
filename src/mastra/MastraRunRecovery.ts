/**
 * @module as-graph/mastra/MastraRunRecovery
 * @summary Resumable run-handle recovery for plain `@mastra/core` runtimes
 * (SAA-926 §6.3).
 * @description `@mastra/core` 1.77.0 exposes no public `getRun` on the `Mastra`
 * class, so a plain runtime cannot hand the backend a run handle for resume and
 * the resume path fails closed. This module recovers resumable run handles the
 * way mastra's own restart recovery does — resolve the persisted run record
 * from the configured storage workflows domain, then rebind the run id onto the
 * live workflow via `createRun({ runId })` — and wraps the recovery in a host
 * injectable `getRun` that prefers a runtime-provided `getRun` when present.
 */
import { isRecord } from "./MastraStorageWiring";

/**
 * Recovers a resumable Mastra run handle for a run that is no longer live in
 * this process. `@mastra/core` 1.77.0 exposes no public `getRun` on the
 * `Mastra` class, so a plain `Mastra` runtime cannot hand the backend a run
 * handle for resume and the resume path fails closed. The recovery path
 * mirrors mastra's own restart recovery: resolve the persisted run record from
 * the configured storage workflows domain to learn the workflow name, then
 * rebind the run id onto the live workflow via `createRun({ runId })`.
 *
 * @param runtime - The wired `Mastra` runtime.
 * @param runId - The run id to recover.
 * @returns The rebound run handle (with `resume`), or `undefined` when the
 *   runtime/storage cannot recover the run.
 */
export async function recoverMastraRunHandle(
  runtime: Record<string, unknown>,
  runId: string
): Promise<unknown | undefined> {
  const getStorage = runtime["getStorage"];
  if (typeof getStorage !== "function") return undefined;
  const storage = await (getStorage as () => unknown).call(runtime);
  if (!isRecord(storage)) return undefined;
  const getStore = storage["getStore"];
  if (typeof getStore !== "function") return undefined;
  const workflows = await (getStore as (domain: string) => unknown).call(
    storage,
    "workflows"
  );
  if (!isRecord(workflows)) return undefined;
  const getWorkflowRunById = workflows["getWorkflowRunById"];
  if (typeof getWorkflowRunById !== "function") return undefined;
  const record = await (getWorkflowRunById as (args: unknown) => unknown).call(
    workflows,
    { runId }
  );
  if (!isRecord(record)) return undefined;
  const workflowName = record["workflowName"];
  if (typeof workflowName !== "string" || workflowName.length === 0) {
    return undefined;
  }
  const getWorkflowById = runtime["getWorkflowById"];
  if (typeof getWorkflowById !== "function") return undefined;
  const resolved = (getWorkflowById as (id: string) => unknown).call(
    runtime,
    workflowName
  );
  const workflow =
    isRecord(resolved) && typeof resolved["createRun"] === "function"
      ? resolved
      : await resolved;
  if (!isRecord(workflow)) return undefined;
  const createRun = workflow["createRun"];
  if (typeof createRun !== "function") return undefined;
  const run = await (createRun as (options?: unknown) => unknown).call(
    workflow,
    { runId }
  );
  if (!isRecord(run) || typeof run["resume"] !== "function") return undefined;
  return run;
}

/**
 * Builds a host-injectable `getRun` wrapper over a real `Mastra` runtime. The
 * wrapper delegates to a runtime-provided `getRun` when present and otherwise
 * falls back to {@link recoverMastraRunHandle}, so a plain `@mastra/core`
 * 1.77.0 `Mastra` instance (no public `getRun`) still yields resumable run
 * handles instead of failing resume closed.
 *
 * @param runtime - The wired `Mastra` runtime.
 * @returns The `getRun` wrapper, or `undefined` when the runtime is not a record.
 */
export function createMastraGetRunWrapper(
  runtime: unknown
): ((runId: string) => Promise<unknown>) | undefined {
  if (!isRecord(runtime)) return undefined;
  return async (runId: string): Promise<unknown> => {
    const getRun = runtime["getRun"];
    if (typeof getRun === "function") {
      return await (getRun as (id: string) => unknown).call(runtime, runId);
    }
    return recoverMastraRunHandle(runtime, runId);
  };
}
