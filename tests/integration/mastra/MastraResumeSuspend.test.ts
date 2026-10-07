/**
 * @module as-graph/tests/integration/mastra/MastraResumeSuspend.test
 * @summary SAA-307 evidence: real `@mastra/core` suspension, the
 * `MastraResumeGuard` fail-closed matrix, a real successful resume, and the C18
 * audit record.
 * @description Real-vs-injected note. **Real**: the `core.flow.humanApproval`
 * step created by the production compiler, the real Mastra run that suspends against
 * a real `InMemoryStore` snapshot, the real `Run.resume` that completes the run,
 * and the production `MastraGraphExecutionBackend` / `MastraResumeGuard`. **Host-
 * injected**: `config.mastra.getRun` (the `Mastra` class exposes no public
 * `getRun`) and the `MastraSuspendStateReader` port (Mastra owns the snapshot).
 * The reader is a thin adapter over the real suspended run, not a fabricated state
 * machine; the fail-closed cases vary only the reader/snapshot/request.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphExecutionEventType, GraphExecutionStatus } from "../../../src/shared/graph/constants";
import { MastraEventBridge } from "../../../src/mastra/MastraEventBridge";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { graphRunDocumentFingerprint } from "../../../src/engine/runs/GraphRunFingerprint";
import {
  GRAPH_MASTRA_RESUME_INVALID,
  GRAPH_MASTRA_RESUME_STATE_INVALID,
  GRAPH_MASTRA_RESUME_STEP_UNKNOWN,
  GRAPH_MASTRA_UNSUPPORTED_KIND,
  type MastraRunSnapshotState,
} from "../../../src/mastra/types";
import {
  collectStream,
  compileDocument,
  frameSinkHarness,
  integrationHumanApprovalDocument,
  realMastraWithWorkflow,
  rejectionGraphCodeOf,
} from "./helpers";

const RUN_ID = "mastra-it-resume-run";

interface RealRun {
  stream: (options?: unknown) => Promise<{
    fullStream: AsyncIterable<Record<string, unknown>>;
    result?: Promise<unknown>;
  }>;
  resume: (options?: unknown) => Promise<{
    status?: string;
    result?: Record<string, unknown>;
  }>;
}

/** Compiles, registers, and runs the document until it suspends. */
async function suspendRealRun(source: GraphWorkflowDocument): Promise<{
  mastra: unknown;
  run: RealRun;
  rawEvents: Record<string, unknown>[];
}> {
  const { compiled } = compileDocument(source, []);
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

/** Builds the host reader returning the given snapshot. */
function readerOf(snapshot: MastraRunSnapshotState | undefined) {
  return {
    readRunState: async () => snapshot,
  };
}

/** A real suspended-run snapshot for the human-approval document. */
function suspendedSnapshot(
  source: GraphWorkflowDocument,
  overrides: Partial<MastraRunSnapshotState> = {}
): MastraRunSnapshotState {
  return {
    runId: RUN_ID,
    workflowId: source.id,
    documentFingerprint: graphRunDocumentFingerprint(source),
    status: "suspended",
    suspendedSteps: ["approve"],
    ...overrides,
  };
}

/**
 * Creates a backend seeded with the document (owner-less) and the given real run +
 * reader, then resumes.
 */
async function resumeWith(
  source: GraphWorkflowDocument,
  run: RealRun | undefined,
  reader: { readRunState: () => Promise<MastraRunSnapshotState | undefined> },
  maxResumeBytes?: number
): Promise<unknown> {
  const backend = new MastraGraphExecutionBackend();
  await backend.initialize({
    mastra: { getRun: async () => run },
    suspendStateReader: reader,
    ...(maxResumeBytes !== undefined ? { maxResumeBytes } : {}),
  });
  const seed = frameSinkHarness("mastra-it-seed-run");
  await backend.execute({
    document: source,
    plan: {} as never,
    inputs: {},
    options: {} as never,
    events: seed.sink,
  });
  return backend.resume(RUN_ID, {
    step: "approve",
    resumeData: { approved: true },
  });
}

describe("Mastra suspend -> real resume (SAA-307 item 2)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("suspends a real run on core.flow.humanApproval and bridges the suspend", async () => {
    const source = integrationHumanApprovalDocument();
    const { rawEvents } = await suspendRealRun(source);

    expect(rawEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["workflow-start", "workflow-step-suspended", "workflow-finish"])
    );
    const finish = rawEvents.find((event) => event.type === "workflow-finish");
    expect((finish?.payload as { workflowStatus?: string })?.workflowStatus).toBe(
      "suspended"
    );

    const { compiled } = compileDocument(source, []);
    const mastra = realMastraWithWorkflow(source.id, compiled.workflow);
    const run = (await (
      mastra.getWorkflow(source.id) as unknown as {
        createRun: (options?: unknown) => Promise<RealRun>;
      }
    ).createRun({ runId: "mastra-it-suspend-bridge" })) as RealRun;
    const harness = frameSinkHarness("mastra-it-suspend-bridge");
    const bridge = new MastraEventBridge({
      runId: "mastra-it-suspend-bridge",
      workflowId: source.id,
      document: source,
      sink: harness.sink,
    });
    const stream = await run.stream({ inputData: {} });
    await bridge.attach(stream.fullStream);
    await stream.result;

    const types = harness.events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_SUSPENDED);
    const suspended = harness.events.find(
      (event) => event.type === GraphExecutionEventType.WORKFLOW_SUSPENDED
    );
    expect(suspended?.status).toBe(GraphExecutionStatus.PENDING);
    expect(suspended?.nodeId).toBe("approve");
  });

  it("resumes a real suspended run through the backend and returns the C18 audit", async () => {
    const source = integrationHumanApprovalDocument();
    const { run } = await suspendRealRun(source);
    const sentinel = "S3NT1NEL-DO-NOT-LOG";
    const reader = readerOf(suspendedSnapshot(source));
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: { getRun: async () => run },
      suspendStateReader: reader,
    });
    const seed = frameSinkHarness("mastra-it-seed-run");
    await backend.execute({
      document: source,
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: seed.sink,
    });

    const audit = await backend.resume(RUN_ID, {
      step: "approve",
      resumeData: { approved: true, secret: sentinel },
    });

    expect(audit.runId).toBe(RUN_ID);
    expect(audit.workflowId).toBe(source.id);
    expect(audit.step).toBe("approve");
    expect(audit.resumeDataHash).toMatch(/^fnv1a:[0-9a-f]{8}:\d+$/);
    expect(audit.resumeDataBytes).toBeGreaterThan(0);
    expect(typeof audit.at).toBe("string");
    expect(Number.isNaN(Date.parse(audit.at as string))).toBe(false);
    // C18: the audit carries provenance only, never the raw resume data.
    expect(audit).not.toHaveProperty("resumeData");
    expect(JSON.stringify(audit)).not.toContain(sentinel);
  });

  it("fails closed when no suspendStateReader is configured", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });

    expect(
      await rejectionGraphCodeOf(() =>
        backend.resume(RUN_ID, { step: "approve", resumeData: { approved: true } })
      )
    ).toBe(GRAPH_MASTRA_UNSUPPORTED_KIND);
  });

  it("fails closed when the reader returns no snapshot", async () => {
    const source = integrationHumanApprovalDocument();
    expect(
      await rejectionGraphCodeOf(() =>
        resumeWith(source, undefined, readerOf(undefined))
      )
    ).toBe(GRAPH_MASTRA_RESUME_STATE_INVALID);
  });

  it("fails closed when the snapshot is not suspended or fingerprint-mismatched", async () => {
    const source = integrationHumanApprovalDocument();
    const { run } = await suspendRealRun(source);

    expect(
      await rejectionGraphCodeOf(() =>
        resumeWith(source, run, readerOf(suspendedSnapshot(source, { status: "running" })))
      )
    ).toBe(GRAPH_MASTRA_RESUME_STATE_INVALID);

    expect(
      await rejectionGraphCodeOf(() =>
        resumeWith(
          source,
          run,
          readerOf(suspendedSnapshot(source, { documentFingerprint: "deadbeef" }))
        )
      )
    ).toBe(GRAPH_MASTRA_RESUME_STATE_INVALID);
  });

  it("fails closed when the resume step is not allowlisted", async () => {
    const source = integrationHumanApprovalDocument();
    const { run } = await suspendRealRun(source);
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: { getRun: async () => run },
      suspendStateReader: readerOf(suspendedSnapshot(source)),
    });
    const seed = frameSinkHarness("mastra-it-seed-run");
    await backend.execute({
      document: source,
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: seed.sink,
    });

    expect(
      await rejectionGraphCodeOf(() =>
        backend.resume(RUN_ID, { step: "other", resumeData: { approved: true } })
      )
    ).toBe(GRAPH_MASTRA_RESUME_STEP_UNKNOWN);
  });

  it("fails closed on oversized or non-JSON-safe resume data", async () => {
    const source = integrationHumanApprovalDocument();
    const { run } = await suspendRealRun(source);

    expect(
      await rejectionGraphCodeOf(() =>
        resumeWith(source, run, readerOf(suspendedSnapshot(source)), 4)
      )
    ).toBe(GRAPH_MASTRA_RESUME_INVALID);

    const unsafeBackend = new MastraGraphExecutionBackend();
    await unsafeBackend.initialize({
      mastra: { getRun: async () => run },
      suspendStateReader: readerOf(suspendedSnapshot(source)),
    });
    const unsafeSeed = frameSinkHarness("mastra-it-seed-run");
    await unsafeBackend.execute({
      document: source,
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: unsafeSeed.sink,
    });
    expect(
      await rejectionGraphCodeOf(() =>
        unsafeBackend.resume(RUN_ID, {
          step: "approve",
          resumeData: { approved: () => true } as unknown as Record<string, unknown>,
        })
      )
    ).toBe(GRAPH_MASTRA_RESUME_INVALID);
  });

  it("fails closed when the suspended node's resume schema rejects the data", async () => {
    const source = integrationHumanApprovalDocument();
    const { run } = await suspendRealRun(source);
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: { getRun: async () => run },
      suspendStateReader: readerOf(suspendedSnapshot(source)),
    });
    const seed = frameSinkHarness("mastra-it-seed-run");
    await backend.execute({
      document: source,
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: seed.sink,
    });

    expect(
      await rejectionGraphCodeOf(() =>
        backend.resume(RUN_ID, {
          step: "approve",
          resumeData: { approved: "yes" },
        })
      )
    ).toBe(GRAPH_MASTRA_RESUME_INVALID);
  });

  it("fails closed when there is no resumable run handle", async () => {
    const source = integrationHumanApprovalDocument();
    expect(
      await rejectionGraphCodeOf(() =>
        resumeWith(source, undefined, readerOf(suspendedSnapshot(source)))
      )
    ).toBe(GRAPH_MASTRA_UNSUPPORTED_KIND);
  });

  it("a real Mastra resume completes the run with the approved result", async () => {
    const source = integrationHumanApprovalDocument();
    const { run } = await suspendRealRun(source);

    const resumed = await run.resume({
      step: "approve",
      resumeData: { approved: true },
    });

    expect(resumed.status).toBe("success");
    expect(
      (resumed.result as { approved?: { approved?: boolean } })?.approved?.approved
    ).toBe(true);
  });
});
