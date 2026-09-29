/**
 * @module as-graph/tests/unit/graph/IsolatedVmCodeSandboxEvaluatorAsyncHang.test
 * @summary SAA-1938 exploit/regression test for F1 of the SAA-1935 security
 * review gate: a never-settling async code-node body must not hang
 * {@link IsolatedVmCodeSandboxEvaluator.evaluate} indefinitely.
 * @description The in-isolate synchronous watchdog (`script.run` `timeout`) only
 * covers synchronous execution. A body that awaits a promise that never settles
 * (`await new Promise(function(){});`) leaves the returned promise pending
 * forever, so the run-level `executionTimeoutMs` abort — which is only observed
 * between nodes — never finalizes the owning run and leaks the per-caller
 * concurrency slot.
 *
 * This test pins the evaluator contract: `evaluate()` must settle (reject with the
 * sandbox timeout error) within a bounded multiple of the configured sandbox
 * timeout. Against the pre-fix evaluator the race below resolves to `pending` and
 * the test fails — the expected RED evidence of the defect. The remediation is
 * owned by the linked remediation issue SAA-1939; do not patch production code.
 */
import { describe, it, expect } from "@jest/globals";
import { IsolatedVmCodeSandboxEvaluator } from "../../../src/engine/execution/IsolatedVmCodeSandboxEvaluator";
import { GraphExecutionError } from "../../../src/engine/errors/GraphExecutionError";

/** Configured in-isolate sandbox timeout. */
const SANDBOX_TIMEOUT_MS = 500;
/**
 * Contract bound: `evaluate()` must settle within this multiple of the configured
 * sandbox timeout. Generous enough for a host-timer-based fix to fire, small
 * enough that the pre-fix unbounded hang cannot accidentally pass.
 */
const SETTLE_BOUND_MS = SANDBOX_TIMEOUT_MS * 4;

/** Outcome of racing `evaluate()` against the settle bound. */
type SettleOutcome =
  | { kind: "resolved"; value: unknown }
  | { kind: "rejected"; error: unknown }
  | { kind: "pending" };

/** Code whose async body never settles. */
const NEVER_SETTLING_CODE = "await new Promise(function(){}); return 1;";

/**
 * Races `promise` against a `boundMs` deadline, always clearing the deadline
 * timer so the test leaves no open handle behind.
 */
async function settleWithin<T>(
  promise: Promise<T>,
  boundMs: number
): Promise<SettleOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value): SettleOutcome => ({ kind: "resolved", value }),
        (error: unknown): SettleOutcome => ({ kind: "rejected", error })
      ),
      new Promise<SettleOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "pending" }), boundMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("IsolatedVmCodeSandboxEvaluator — never-settling async body (SAA-1938 F1)", () => {
  it("rejects a never-settling async body within a bounded multiple of the sandbox timeout", async () => {
    const evaluator = new IsolatedVmCodeSandboxEvaluator(
      SANDBOX_TIMEOUT_MS,
      8
    );
    const startedAt = Date.now();

    const outcome = await settleWithin(
      evaluator.evaluate({ code: NEVER_SETTLING_CODE, input: {} }),
      SETTLE_BOUND_MS
    );

    const elapsedMs = Date.now() - startedAt;

    // The defect: against the pre-fix evaluator the promise is still pending.
    expect(outcome.kind).not.toBe("pending");
    // The contract: the call settled within the bounded multiple.
    expect(elapsedMs).toBeLessThanOrEqual(SETTLE_BOUND_MS);
    // The contract: it settled by rejecting with the sandbox timeout error.
    expect(outcome.kind).toBe("rejected");
    const error = (outcome as { kind: "rejected"; error: unknown }).error;
    expect(error).toBeInstanceOf(GraphExecutionError);
    expect((error as GraphExecutionError).message).toMatch(/timed out|timeout/i);
  }, 30_000);
});
