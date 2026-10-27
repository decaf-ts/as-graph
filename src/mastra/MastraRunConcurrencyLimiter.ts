/**
 * @module as-graph/mastra/MastraRunConcurrencyLimiter
 * @summary Run-scoped concurrency gate for Mastra workflow steps (SAA-1545 §4).
 * @description The facade's execution `concurrency` option bounds how many
 * nodes a layer may execute at once. Native `workflow.parallel(...)` groups do
 * not know that option, so the compiler wraps every translated step in
 * {@link withMastraRunConcurrency}: the first step of a run installs a gate
 * sized from the run's effective ceiling, later steps acquire a slot before
 * executing a node, and the backend releases the gate in its terminal
 * `finally`. Gates are isolated by run id, so concurrent runs never share
 * capacity, and a run without a configured ceiling executes unthrottled.
 */

/**
 * A run's in-memory concurrency budget.
 *
 * @property ceiling - The maximum number of simultaneous step executions.
 * @property active - The number of slots currently held by executing steps.
 * @property queue - Resolvers for steps waiting for a slot, in FIFO order.
 */
interface RunConcurrencyGate {
  /** The maximum number of simultaneous step executions. */
  readonly ceiling: number;
  /** The number of slots currently held by executing steps. */
  active: number;
  /** Resolvers for steps waiting for a slot, in FIFO order. */
  readonly queue: Array<() => void>;
}

/** Active gates keyed by run id; runs absent from the map are unthrottled. */
const gates = new Map<string, RunConcurrencyGate>();

/**
 * Creates or replaces the concurrency gate for one run.
 *
 * A usable ceiling is a finite number greater than zero; it is floored to an
 * integer. Any other value, or a missing `runId`, removes the run's gate so
 * subsequent steps execute unthrottled. Reconfiguring a run that already has a
 * gate discards the old queue, so this is normally called once at run start.
 *
 * @param {string | undefined} runId - The canonical run id; a missing id is a no-op.
 * @param {number | undefined} ceiling - The maximum simultaneous step count.
 * @returns {void}
 * @example
 * configureMastraRunConcurrency("run-1", 4);
 * await withMastraRunConcurrency("run-1", () => step.execute());
 */
export function configureMastraRunConcurrency(
  runId: string | undefined,
  ceiling: number | undefined
): void {
  if (!runId) return;
  if (
    typeof ceiling !== "number" ||
    !Number.isFinite(ceiling) ||
    ceiling <= 0
  ) {
    gates.delete(runId);
    return;
  }
  gates.set(runId, {
    ceiling: Math.floor(ceiling),
    active: 0,
    queue: [],
  });
}

/**
 * Removes a run's concurrency gate when the run reaches a terminal state.
 *
 * Future {@link withMastraRunConcurrency} calls for the run execute unthrottled.
 * Work already executing is not cancelled, and waiters already queued on the
 * removed gate are not drained by this call.
 *
 * @param {string | undefined} runId - The canonical run id; a missing id is a no-op.
 * @returns {void}
 * @example
 * try {
 *   await runWorkflow();
 * } finally {
 *   releaseMastraRunConcurrency(runId);
 * }
 */
export function releaseMastraRunConcurrency(runId: string | undefined): void {
  if (!runId) return;
  gates.delete(runId);
}

/**
 * Runs one task under the run's concurrency ceiling.
 *
 * A run with no gate (or no `runId`) executes the task immediately. Otherwise
 * the task acquires a slot, waiting in FIFO order while the gate is at its
 * ceiling, and always releases the slot in a `finally` — including when the
 * task throws — before the next waiter is admitted.
 *
 * @template T The task's resolved value type.
 * @param {string | undefined} runId - The canonical run id whose gate to use.
 * @param {function(): Promise<T> | T} task - The step work to execute under the gate.
 * @returns {Promise<T>} A promise resolving with the task's value.
 * @example
 * const output = await withMastraRunConcurrency(runId, () => executeStep(input));
 * @mermaid
 * sequenceDiagram
 *   autonumber
 *   participant S as Step
 *   participant L as Limiter
 *   participant Q as Run gate
 *   S->>L: withMastraRunConcurrency(runId, task)
 *   L->>Q: active >= ceiling?
 *   alt slot available
 *     Q-->>L: acquire slot
 *   else gate full
 *     L->>Q: enqueue waiter (FIFO)
 *     Q-->>L: slot released
 *   end
 *   L->>S: await task()
 *   S-->>L: result or error
 *   L->>Q: release slot, admit next waiter
 *   L-->>S: result or rethrow
 */
export async function withMastraRunConcurrency<T>(
  runId: string | undefined,
  task: () => Promise<T> | T
): Promise<T> {
  const gate = runId ? gates.get(runId) : undefined;
  if (!gate) return await task();
  if (gate.active >= gate.ceiling) {
    await new Promise<void>((resolve) => {
      gate.queue.push(() => {
        gate.active += 1;
        resolve();
      });
    });
  } else {
    gate.active += 1;
  }
  try {
    return await task();
  } finally {
    gate.active -= 1;
    const next = gate.queue.shift();
    if (next) next();
  }
}
