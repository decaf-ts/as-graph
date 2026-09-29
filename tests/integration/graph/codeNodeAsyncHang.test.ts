/**
 * @module as-graph/tests/integration/graph/codeNodeAsyncHang.test
 * @summary SAA-1938 exploit/regression test for F1 of the SAA-1935 security
 * review gate: a never-settling async `core.utility.code` node must not strand
 * its owning run and leak the per-caller concurrency slot.
 * @description Drives the real migrated engine (isolated-vm sandbox evaluator +
 * built-in `core.utility.code` node) through {@link GraphRunService} with
 * `limits.maxConcurrentRuns: 1` and a short `executionTimeoutMs`. A code body of
 * `await new Promise(function(){});` hangs `evaluate()` forever; because the
 * run-level abort is only observed between nodes, the run never finalizes,
 * `GraphRunService.finishActiveRun` never runs, and the caller's slot leaks.
 *
 * This test pins the contract: the run must reach a terminal state within a
 * bounded multiple of `executionTimeoutMs` and the caller's concurrency slot must
 * be released (observable as the internal bucket maps draining and a subsequent
 * createRun for the same caller being accepted). Against the pre-fix evaluator the
 * race below resolves to `pending` and the test fails — the expected RED evidence
 * of the defect. The remediation is owned by the linked remediation issue
 * SAA-1939; do not patch production code here.
 */
import { describe, it, expect } from "@jest/globals";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { isGraphRunTerminalStatus } from "../../../src/shared/graph";
import { CODE_GRAPH_NODE_MANIFEST, CodeNode } from "../../../src/node";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { IsolatedVmCodeSandboxEvaluator } from "../../../src/engine/execution/IsolatedVmCodeSandboxEvaluator";
import { GraphNodeCatalogue } from "../../../src/engine/catalog/GraphNodeCatalogue";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { registerBuiltInGraphNodes } from "../../../src/engine/catalog/GraphBuiltInRegistrations";
import { defineGraphNode } from "../../../src/engine/catalog/GraphNodeRegistration";
import {
  GraphRunService,
  InMemoryGraphRunStore,
  InMemoryGraphRunEventStore,
  type GraphRun,
} from "../../../src";
import {
  documentEdge,
  documentNode,
  documentPort,
  resolveDocument,
} from "../../unit/graph/engine-fixtures";

/** Configured run-level execution timeout. */
const RUN_TIMEOUT_MS = 500;
/**
 * Contract bound: the run must reach a terminal state within this multiple of
 * `executionTimeoutMs`. Generous enough for a host-bound fix to finalize the run,
 * small enough that the pre-fix unbounded hang cannot accidentally pass.
 */
const RUN_SETTLE_BOUND_MS = RUN_TIMEOUT_MS * 4;

/** Code whose async body never settles. */
const NEVER_SETTLING_CODE = "await new Promise(function(){}); return 1;";

/** Internal per-caller bookkeeping of {@link GraphRunService}, for leak assertions. */
interface RunServiceInternals {
  activeByCaller: Map<string, Set<string>>;
  callerKeysByRun: Map<string, string>;
  releaseTimers: Map<string, ReturnType<typeof setTimeout>>;
}

/** Outcome of racing a run's completion against the settle bound. */
type RunOutcome =
  | { kind: "terminal"; settled: GraphRun }
  | { kind: "pending" };

/**
 * Races a run's completion against a `boundMs` deadline, always clearing the
 * deadline timer so the test leaves no open handle behind.
 */
async function settleRunWithin(
  service: GraphRunService,
  runId: string,
  owner: string,
  boundMs: number
): Promise<RunOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      service
        .waitForRun(runId, owner)
        .then((settled): RunOutcome => ({ kind: "terminal", settled })),
      new Promise<RunOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "pending" }), boundMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Builds an engine backed by the built-in node catalogue and the isolated-vm
 * code sandbox evaluator, mirroring `createDemoEngineConfig`'s wiring.
 *
 * The compiled `code` port schema is a decaf `String` model, which rejects
 * string literal bindings. The built-in `core.utility.code` node is therefore
 * re-registered with a string schema for `code` (the executor stays the real
 * `CodeNode` + sandbox), so canonical documents can bind code literally.
 */
function buildEngine(): {
  engine: GraphExecutionEngine;
  catalogue: GraphNodeCatalogue;
} {
  const catalogue = new GraphNodeCatalogue();
  const engine = new GraphExecutionEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    codeSandboxEvaluator: new IsolatedVmCodeSandboxEvaluator(),
  });
  registerBuiltInGraphNodes(catalogue, engine);
  catalogue.register(
    defineGraphNode({
      manifest: {
        ...CODE_GRAPH_NODE_MANIFEST,
        inputs: CODE_GRAPH_NODE_MANIFEST.inputs.map((port) =>
          port.id === "code" ? { ...port, schema: { type: "string" } } : port
        ),
      },
      executor: {
        execute: (request, context) => CodeNode.execute(request, context),
      },
    }),
    { replace: true }
  );
  return { engine, catalogue };
}

/**
 * Builds a one-node document whose only node is a `core.utility.code` node with a
 * never-settling async body, connected to the workflow input/output so the node is
 * not rejected as loose.
 */
function neverSettlingDocument(): GraphWorkflowDocument {
  return {
    id: "wf-code-async-hang",
    name: "wf-code-async-hang",
    inputs: [documentPort("n")],
    outputs: [documentPort("result")],
    nodes: [
      documentNode("hang", "core.utility.code", {}, {
        inputBindings: {
          code: { mode: "literal", value: NEVER_SETTLING_CODE },
        },
      }),
    ],
    edges: [
      documentEdge("e1", ["workflow", "n"], ["node", "hang", "data"]),
      documentEdge("e2", ["node", "hang", "result"], ["workflow", "result"]),
    ],
  };
}

describe("core.utility.code never-settling async node (SAA-1938 F1)", () => {
  it("finalizes the owning run and releases the caller's concurrency slot within a bounded multiple of executionTimeoutMs", async () => {
    const { engine, catalogue } = buildEngine();
    const document = neverSettlingDocument();
    await resolveDocument(document, catalogue);

    const service = new GraphRunService(
      engine,
      new InMemoryGraphRunStore(),
      new InMemoryGraphRunEventStore(),
      {
        limits: {
          maxConcurrentRuns: 1,
          executionTimeoutMs: RUN_TIMEOUT_MS,
          eventReplayWindowMs: 50,
        },
      }
    );
    const owner = "hang-owner";

    const run = await service.createRun(
      { workflow: document, inputs: { n: 1 } },
      owner
    );
    expect(run.status).toBe("queued");

    const startedAt = Date.now();
    const outcome = await settleRunWithin(
      service,
      run.runId,
      owner,
      RUN_SETTLE_BOUND_MS
    );
    const elapsedMs = Date.now() - startedAt;

    // The defect: against the pre-fix evaluator the run never finalizes.
    expect(outcome.kind).not.toBe("pending");
    // The contract: the run reached a terminal state within the bounded multiple.
    expect(elapsedMs).toBeLessThanOrEqual(RUN_SETTLE_BOUND_MS);

    const terminalRun = (outcome as { kind: "terminal"; settled: GraphRun })
      .settled;
    expect(isGraphRunTerminalStatus(terminalRun.status)).toBe(true);
    expect(terminalRun.status).toBe("failed");

    // The contract: the caller's concurrency slot is released.
    const internals = service as unknown as RunServiceInternals;
    expect(internals.activeByCaller.size).toBe(0);
    expect(internals.callerKeysByRun.size).toBe(0);

    // The contract: a fresh run for the same caller is accepted (slot freed).
    const second = await service.createRun(
      { workflow: document, inputs: { n: 2 } },
      owner
    );
    expect(second.status).toBe("queued");

    // Drain the second run through cancellation so the test leaves no live run.
    await service.cancelRun(second.runId, owner);
    await settleRunWithin(service, second.runId, owner, RUN_SETTLE_BOUND_MS);
  }, 30_000);
});
