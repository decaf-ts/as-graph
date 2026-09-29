/**
 * @module as-graph/tests/unit/graph/GraphRunConcurrency
 * @summary SAA-595 regression tests: per-caller concurrency buckets
 * (scenario 2 of the SAA-608 review follow-up).
 * @description Drives {@link GraphRunService} directly (engine-level, no
 * HTTP) with `limits.maxConcurrentRuns: 1` and a blocking node executor, and
 * pins the per-caller bucket semantics the SAA-595 hardening introduced:
 * - a caller exhausting their own bucket does not affect other callers:
 *   bob and distinct `ip:`-keyed anonymous callers still create runs while
 *   alice's bucket is full;
 * - the second createRun for a full bucket rejects with the
 *   `... per caller is exhausted` validation error;
 * - after a run reaches a terminal state and the `eventReplayWindowMs`
 *   auto-release fires, the caller's bucket is free again;
 * - the internal bookkeeping maps (`activeByCaller`, `callerKeysByRun`,
 *   `releaseTimers`) return to empty — no per-caller or per-run leak.
 *
 * The blocking executor gates on actual executor entry (not creation time),
 * so "bucket exhausted" is asserted against provably in-flight runs.
 */
import { jest, describe, beforeAll, afterAll, it, expect } from "@jest/globals";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { ValidationError } from "@decaf-ts/db-decorators";

import {
  GraphExecutionEngine,
  GraphNodeCatalogue,
  GraphNodeExecutorRegistry,
  GraphRunService,
  InMemoryGraphRunEventStore,
  InMemoryGraphRunStore,
  type GraphNodeExecutor,
  type GraphRun,
} from "../../../src";
import { documentEdge, documentNode } from "./engine-fixtures";

jest.setTimeout(30000);

/** Auto-release window used for these tests: short so bucket recovery is fast. */
const REPLAY_WINDOW_MS = 100;
/** Margin waited past {@link REPLAY_WINDOW_MS} for the auto-release timer. */
const DRAIN_MS = 250;

/**
 * A two-node document: the blocking node feeds a clean sink. The sink keeps the
 * blocking node connected (DECAF-50 §4.26 R2-3(8) rejects loose nodes).
 */
function blockingDocument(workflowId: string): GraphWorkflowDocument {
  return {
    id: workflowId,
    name: workflowId,
    inputs: [],
    outputs: [],
    nodes: [
      documentNode(`${workflowId}-n1`, "test.block"),
      documentNode(`${workflowId}-sink`, "test.sink"),
    ],
    edges: [
      documentEdge(
        `${workflowId}-e1`,
        ["node", `${workflowId}-n1`, "out"],
        ["node", `${workflowId}-sink`, "in"]
      ),
    ],
  };
}

/** Internal per-caller bookkeeping of {@link GraphRunService}, for leak assertions. */
interface RunServiceInternals {
  activeByCaller: Map<string, Set<string>>;
  callerKeysByRun: Map<string, string>;
  releaseTimers: Map<string, ReturnType<typeof setTimeout>>;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("GraphRunConcurrency (SAA-595 per-caller buckets)", () => {
  let service: GraphRunService;
  let internals: RunServiceInternals;
  /** Resolvers of blocked executor invocations, in entry order. */
  let blocked: Array<() => void> = [];
  /** Number of executor invocations that have actually been entered. */
  let entered = 0;

  /** Executor that blocks every invocation until the test releases it. */
  const blockingExecutor: GraphNodeExecutor = {
    execute: () =>
      new Promise((resolve) => {
        entered += 1;
        blocked.push(() => resolve({ out: true }));
      }),
  };

  /** Resolves once `count` executor invocations are provably in flight. */
  async function waitForEntries(count: number, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (entered < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `Only ${entered} of ${count} blocked executions entered within ${timeoutMs}ms`
        );
      }
      await delay(10);
    }
  }

  /** Creates a run and records it for the terminal-state drain in test 2. */
  const created: Array<{ runId: string; owner: string | null }> = [];
  async function createRun(
    workflowId: string,
    owner: string | null,
    concurrencyKey?: string
  ): Promise<GraphRun> {
    const run = await service.createRun(
      { workflow: blockingDocument(workflowId), inputs: {} },
      owner,
      ...(concurrencyKey === undefined ? [] : [concurrencyKey])
    );
    created.push({ runId: run.runId, owner });
    return run;
  }

  /** Expects createRun to reject with the per-caller exhaustion error. */
  async function expectExhausted(
    workflowId: string,
    owner: string | null,
    concurrencyKey?: string
  ): Promise<void> {
    let rejected: unknown;
    try {
      await createRun(workflowId, owner, concurrencyKey);
    } catch (e: unknown) {
      rejected = e;
    }
    expect(rejected).toBeInstanceOf(ValidationError);
    expect((rejected as ValidationError).message).toContain(
      "per caller is exhausted"
    );
  }

  beforeAll(() => {
    blocked = [];
    entered = 0;
    const catalogue = new GraphNodeCatalogue();
    const engine = new GraphExecutionEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
    });
    catalogue.registerExecutor("test.block", blockingExecutor);
    catalogue.registerExecutor("test.sink", {
      execute: async () => ({ ok: true }),
    });
    service = new GraphRunService(
      engine,
      new InMemoryGraphRunStore(),
      new InMemoryGraphRunEventStore(),
      {
        limits: {
          maxConcurrentRuns: 1,
          eventReplayWindowMs: REPLAY_WINDOW_MS,
        },
      }
    );
    internals = service as unknown as RunServiceInternals;
  });

  afterAll(() => {
    for (const release of blocked) release();
  });

  it("1. concurrency buckets are per-caller: exhausting alice's bucket leaves bob and distinct anonymous IP buckets unaffected", async () => {
    // alice fills her bucket (limit 1)
    const aliceRun = await createRun("conc-alice-1", "alice");
    expect(aliceRun.status).toBe("queued");

    // alice's second run is rejected with the per-caller exhaustion error
    await expectExhausted("conc-alice-2", "alice");

    // bob has his own bucket and still succeeds
    const bobRun = await createRun("conc-bob-1", "bob");
    expect(bobRun.status).toBe("queued");

    // anonymous callers are bucketed by their caller key: one per IP
    const ip1First = await createRun("conc-anon-ip1-a", null, "ip:203.0.113.9");
    expect(ip1First.status).toBe("queued");
    await expectExhausted("conc-anon-ip1-b", null, "ip:203.0.113.9");
    const ip2Run = await createRun("conc-anon-ip2", null, "ip:198.51.100.7");
    expect(ip2Run.status).toBe("queued");

    // all four runs are provably in flight before the bucket assertions
    await waitForEntries(4);

    // internal bookkeeping: one active run per caller bucket
    expect([...internals.activeByCaller.keys()].sort()).toEqual(
      ["alice", "bob", "ip:198.51.100.7", "ip:203.0.113.9"].sort()
    );
    for (const bucket of internals.activeByCaller.values()) {
      expect(bucket.size).toBe(1);
    }
    expect(internals.callerKeysByRun.size).toBe(4);
    expect(internals.releaseTimers.size).toBe(0);
  });

  it("2. after terminal state and the replay-window auto-release, the caller's bucket is free again and the maps do not leak", async () => {
    // let every blocked run finish
    for (const release of blocked) release();
    blocked = [];

    const terminal = await Promise.all(
      created.slice(0, 4).map(({ runId, owner }) =>
        service.waitForRun(runId, owner)
      )
    );
    for (const run of terminal) {
      expect(run.status).toBe("succeeded");
    }

    // buckets drain immediately on completion; release timers are pending
    expect(internals.activeByCaller.size).toBe(0);
    expect(internals.callerKeysByRun.size).toBe(0);
    expect(internals.releaseTimers.size).toBe(4);

    // after the replay window the auto-release fires and clears the timers
    await delay(DRAIN_MS);
    expect(internals.releaseTimers.size).toBe(0);
    expect(internals.activeByCaller.size).toBe(0);
    expect(internals.callerKeysByRun.size).toBe(0);

    // alice's bucket is free: a new run is accepted and completes
    const aliceAgain = await createRun("conc-alice-3", "alice");
    expect(aliceAgain.status).toBe("queued");
    await waitForEntries(5);
    for (const release of blocked) release();
    blocked = [];
    const finished = await service.waitForRun(aliceAgain.runId, "alice");
    expect(finished.status).toBe("succeeded");

    // drain the final auto-release timer before the process exits
    await delay(DRAIN_MS);
    expect(internals.releaseTimers.size).toBe(0);
    expect(internals.activeByCaller.size).toBe(0);
    expect(internals.callerKeysByRun.size).toBe(0);
  });
});
