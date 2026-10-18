/**
 * @module as-graph/tests/integration/mastra/MastraHitlRun
 * @summary SAA-836 M5 integration: a `core.agent.hitl` workflow suspends at the
 * node with the message/prompt payload and resumes with the user's input
 * through the backend resume path; the run service's owner-equality gate
 * denies a foreign owner.
 * @description Real: the production HITL step handler, the real mastra run
 * suspending against the live Postgres stack, the production
 * `MastraGraphExecutionBackend` resume path, and the production
 * `GraphRunService.resumeRun` owner-equality gate. Host-injected: the backend's
 * `getRun` handle and the `MastraSuspendStateReader` snapshot (mastra owns the
 * suspended-run state), and the fake run/event stores backing the service-level
 * gate probe.
 */
import {
  describe,
  it,
  expect,
  afterEach,
  afterAll,
  beforeEach,
} from "@jest/globals";
import { ForbiddenError } from "@decaf-ts/core";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { createMastraHitlStepHandler } from "../../../src/mastra/MastraHitlStepHandler";
import { type MastraRunSnapshotState } from "../../../src/mastra/types";
import { GraphRunService } from "../../../src/engine/runs/GraphRunService";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { graphRunDocumentFingerprint } from "../../../src/engine/runs/GraphRunFingerprint";
import { document, node } from "../../../src/workflows/builders";
import {
  collectStream,
  compileDocument,
  frameSinkHarness,
  realMastraWithWorkflow,
  rejectionGraphCodeOf,
} from "./helpers";
import {
  closeLiveStores,
  liveCount,
  liveDescribe,
  purgeLiveRuns,
  sharedLiveStorage,
} from "./live-stack";

const RUN_ID = "mastra-it-hitl-run";

interface RealRun {
  stream: (options?: unknown) => Promise<{
    fullStream: AsyncIterable<Record<string, unknown>>;
    result?: Promise<unknown>;
  }>;
  resume: (options?: unknown) => Promise<Record<string, unknown>>;
}

/** A HITL document: a single human-in-the-loop node. */
function hitlDocument(): GraphWorkflowDocument {
  return document({
    id: "mastra-it-hitl",
    name: "mastra-it-hitl",
    nodes: [
      node("hitl", "core.agent.hitl", {
        message: "Need a human decision",
        prompt: "Approve the refund?",
        resumeSchema: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
            value: { type: "string" },
          },
        },
      }),
    ],
  });
}

/** Compiles, registers, and runs the document until it suspends. */
async function suspendHitlRun(source: GraphWorkflowDocument): Promise<{
  mastra: unknown;
  run: RealRun;
  rawEvents: Record<string, unknown>[];
}> {
  const { compiled } = compileDocument(source, [createMastraHitlStepHandler()]);
  const mastra = realMastraWithWorkflow(source.id, compiled.workflow);
  const run = (await (
    mastra.getWorkflow(source.id) as unknown as {
      createRun: (options?: unknown) => Promise<RealRun>;
    }
  ).createRun({ runId: RUN_ID })) as RealRun;
  const stream = await run.stream({ inputData: {} });
  const rawEvents = await collectStream(stream.fullStream);
  return { mastra, run, rawEvents };
}

/** The real suspended-run snapshot for the HITL document. */
function hitlSnapshot(source: GraphWorkflowDocument): MastraRunSnapshotState {
  return {
    runId: RUN_ID,
    workflowId: source.id,
    documentFingerprint: graphRunDocumentFingerprint(source),
    status: "suspended",
    suspendedSteps: ["hitl"],
  };
}

/** A run handle whose `resume` result is recorded before the backend drops it. */
function recordingRun(run: RealRun): {
  handle: RealRun;
  results: Record<string, unknown>[];
} {
  const results: Record<string, unknown>[] = [];
  return {
    handle: {
      stream: (options) => run.stream(options),
      resume: async (options) => {
        const result = await run.resume(options);
        results.push(result);
        return result;
      },
    },
    results,
  };
}

liveDescribe("mastra HITL suspend -> backend resume (SAA-836 M5)", () => {
  beforeEach(async () => {
    await purgeLiveRuns(
      sharedLiveStorage(),
      [RUN_ID, "mastra-it-hitl-seed", "mastra-it-hitl-seed-decline"],
      ["mastra-it-hitl"]
    );
  });

  afterAll(async () => {
    await purgeLiveRuns(
      sharedLiveStorage(),
      [RUN_ID, "mastra-it-hitl-seed", "mastra-it-hitl-seed-decline"],
      ["mastra-it-hitl"]
    );
    await closeLiveStores();
  });

  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("suspends at the hitl node with the message/prompt payload", async () => {
    const source = hitlDocument();
    const { rawEvents } = await suspendHitlRun(source);

    const suspended = rawEvents.find(
      (event) => event.type === "workflow-step-suspended"
    );
    expect(suspended).toBeDefined();
    const payload = suspended?.payload as {
      suspendPayload?: Record<string, unknown>;
    };
    expect(payload.suspendPayload).toEqual({
      message: "Need a human decision",
      prompt: "Approve the refund?",
    });
    const finish = rawEvents.find((event) => event.type === "workflow-finish");
    expect(
      (finish?.payload as { workflowStatus?: string })?.workflowStatus
    ).toBe("suspended");
  });

  it("resumes with the user's input through the backend resume path", async () => {
    const source = hitlDocument();
    const { run } = await suspendHitlRun(source);
    const recorded = recordingRun(run);
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: { getRun: async () => recorded.handle },
      suspendStateReader: { readRunState: async () => hitlSnapshot(source) },
    });
    const seed = frameSinkHarness("mastra-it-hitl-seed");
    await backend.execute({
      document: source,
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: seed.sink,
    });

    const audit = await backend.resume(RUN_ID, {
      step: "hitl",
      resumeData: { approved: true, value: "yes-do-it" },
    });

    expect(audit.runId).toBe(RUN_ID);
    expect(audit.workflowId).toBe(source.id);
    expect(audit.step).toBe("hitl");
    expect(audit).not.toHaveProperty("resumeData");
    // The user's input was routed onto the canonical `approved` output and the
    // real mastra run completed.
    const resumed = recorded.results[0] as {
      status?: string;
      result?: Record<string, unknown>;
    };
    expect(resumed.status).toBe("success");
    expect(resumed.result).toEqual({ approved: "yes-do-it" });

    const snapshots = await liveCount(
      sharedLiveStorage(),
      'SELECT count(*)::int AS count FROM "mastra".mastra_workflow_snapshot WHERE run_id = $1 AND workflow_name = $2',
      [RUN_ID, source.id]
    );
    expect(snapshots).toBe(1);
    const status = await sharedLiveStorage().db.one<{ status: string }>(
      "SELECT snapshot->>'status' AS status FROM \"mastra\".mastra_workflow_snapshot WHERE run_id = $1",
      [RUN_ID]
    );
    expect(status.status).toBe("success");
  });

  it("routes an explicit decline onto the rejected output", async () => {
    const source = hitlDocument();
    const { run } = await suspendHitlRun(source);
    const recorded = recordingRun(run);
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: { getRun: async () => recorded.handle },
      suspendStateReader: { readRunState: async () => hitlSnapshot(source) },
    });
    const seed = frameSinkHarness("mastra-it-hitl-seed-decline");
    await backend.execute({
      document: source,
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: seed.sink,
    });

    const suspended = seed.events.find(
      (event) => event.type === GraphExecutionEventType.WORKFLOW_SUSPENDED
    );
    expect(suspended?.status).toBe(GraphExecutionStatus.PENDING);

    await backend.resume(RUN_ID, {
      step: "hitl",
      resumeData: { approved: false, value: "no-way" },
    });
    const resumed = recorded.results[0] as {
      status?: string;
      result?: Record<string, unknown>;
    };
    expect(resumed.status).toBe("success");
    expect(resumed.result).toEqual({ rejected: "no-way" });
  });
});

describe("GraphRunService resume owner-equality gate (SAA-836 M5 HITL)", () => {
  /** Builds a service over a fake store holding one owned, suspended run. */
  function serviceWithRun(ownerUser: string | null): GraphRunService {
    const run = {
      runId: RUN_ID,
      workflowId: "mastra-it-hitl",
      ownerUser,
      status: "suspended",
      createdAt: new Date().toISOString(),
    };
    const runStore = {
      saveRun: async () => undefined,
      readRun: async () => run,
      listRuns: async () => [],
    };
    const eventStore = {
      append: async () => undefined,
      listAfter: async () => [],
      subscribe: () => () => undefined,
    };
    // A backend without the resume extension: past the gate the service fails
    // closed with GRAPH_RESUME_UNSUPPORTED_BACKEND, proving the gate admitted
    // the legitimate owner before any backend interaction.
    return new GraphRunService(
      { backend: {} } as never,
      runStore as never,
      eventStore as never
    );
  }

  it("denies a foreign-owner resume", async () => {
    const service = serviceWithRun("alice");
    let error: unknown;
    try {
      await service.resumeRun(
        RUN_ID,
        { step: "hitl", resumeData: { approved: true } },
        "mallory"
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it("denies a named caller resuming an owner-less run", async () => {
    const service = serviceWithRun(null);
    let error: unknown;
    try {
      await service.resumeRun(
        RUN_ID,
        { step: "hitl", resumeData: { approved: true } },
        "mallory"
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it("admits the recorded owner past the gate (fails closed on the backend instead)", async () => {
    const service = serviceWithRun("alice");
    expect(
      await rejectionGraphCodeOf(() =>
        service.resumeRun(
          RUN_ID,
          { step: "hitl", resumeData: { approved: true } },
          "alice"
        )
      )
    ).toBe("GRAPH_RESUME_UNSUPPORTED_BACKEND");
  });
});
