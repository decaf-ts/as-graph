/**
 * @module as-graph/tests/integration/mastra/MastraRunRecoveryResume
 * @summary SAA-926 §6.3 acceptance: a suspended real Mastra run is resumed by
 * the backend without any host-provided `getRun`, by recovering the run handle
 * from the storage workflows domain (`getWorkflowRunById` →
 * `getWorkflowById` → `createRun({ runId })`).
 * @description Real: the production compiler, a real `@mastra/core` workflow
 * whose `core.flow.humanApproval` step suspends, a real Postgres persistence
 * boundary, and the production `MastraGraphExecutionBackend`
 * resume path. **Host-injected**: only the `MastraSuspendStateReader` port
 * (Mastra owns the suspended snapshot) and the frame-bound event sink.
 *
 * The process-side run handle returned by the initial `createRun` is discarded
 * and the runtime is replaced with a fresh `Mastra` over the same storage,
 * mirroring a process restart: `@mastra/core` 1.77.0 exposes no public
 * `getRun`, so the only way `loadRun` can recover `RUN_ID` is the production
 * storage-recovery fallback under test.
 */
import {
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from "@jest/globals";
import { Mastra } from "@mastra/core/mastra";
import type { PostgresStore } from "@mastra/pg";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { graphRunDocumentFingerprint } from "../../../src/engine/runs/GraphRunFingerprint";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import type { MastraRunSnapshotState } from "../../../src/mastra/types";
import {
  collectStream,
  compileDocument,
  frameSinkHarness,
  integrationHumanApprovalDocument,
} from "./helpers";
import {
  closeLiveStores,
  createLiveStorage,
  liveCount,
  liveDescribe,
  purgeLiveRuns,
  sharedLiveStorage,
} from "./live-stack";

const RUN_ID = "mastra-it-recovery-run";
const SEED_RUN_ID = "mastra-it-recovery-seed";

const OBSERVABILITY_ENABLED_OVERRIDE = "MASTRA__OBSERVABILITY__ENABLED";
let observabilityEnabledOriginal: string | undefined;

beforeAll(() => {
  observabilityEnabledOriginal = process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  process.env[OBSERVABILITY_ENABLED_OVERRIDE] = "false";
});

afterAll(() => {
  if (observabilityEnabledOriginal === undefined) {
    delete process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  } else {
    process.env[OBSERVABILITY_ENABLED_OVERRIDE] = observabilityEnabledOriginal;
  }
});

afterEach(() => {
  GraphExecutionBackendRegistry.clear();
});

interface StorageRecord {
  workflowName?: string;
  snapshot?: {
    status?: string;
    suspendedPaths?: Record<string, unknown>;
    output?: unknown;
  };
}

/** A real Mastra runtime over the given durable boundary with the workflow registered. */
function runtimeOver(
  storage: PostgresStore,
  workflow: unknown,
  id: string
): Mastra {
  return new Mastra({ storage, workflows: { [id]: workflow as never } });
}

/**
 * Starts the workflow and lets it suspend, then drops the process-side run and
 * runtime references (the snapshot remains in `storage`).
 */
async function suspendAndDiscard(
  source: GraphWorkflowDocument,
  storage: PostgresStore
): Promise<void> {
  const { compiled } = compileDocument(source, []);
  const origin = runtimeOver(storage, compiled.workflow, source.id);
  const run = await (
    origin.getWorkflow(source.id) as unknown as {
      createRun: (options?: unknown) => Promise<{
        stream: (options?: unknown) => Promise<{
          fullStream: AsyncIterable<Record<string, unknown>>;
        }>;
      }>;
    }
  ).createRun({ runId: RUN_ID });
  const stream = await run.stream({ inputData: {} });
  const events = await collectStream(stream.fullStream);
  expect(
    events.some((event) => event["type"] === "workflow-step-suspended")
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event["type"] === "workflow-finish" &&
        (event["payload"] as { workflowStatus?: string } | undefined)
          ?.workflowStatus === "suspended"
    )
  ).toBe(true);
}

/** Reads the persisted run record from the storage workflows domain. */
async function persistedRecord(storage: PostgresStore): Promise<StorageRecord> {
  const workflows = (await storage.getStore("workflows")) as unknown as {
    getWorkflowRunById: (args: {
      runId: string;
    }) => Promise<StorageRecord | null>;
  };
  const record = await workflows.getWorkflowRunById({ runId: RUN_ID });
  expect(record).not.toBeNull();
  return record as StorageRecord;
}

/** The host's authoritative suspend snapshot, read from real Mastra storage. */
async function snapshotFromStorage(
  storage: PostgresStore,
  source: GraphWorkflowDocument
): Promise<MastraRunSnapshotState> {
  const record = await persistedRecord(storage);
  const suspendedSteps = Object.keys(record.snapshot?.suspendedPaths ?? {});
  expect(suspendedSteps).toContain("approve");
  return {
    runId: RUN_ID,
    workflowId: record.workflowName ?? source.id,
    documentFingerprint: graphRunDocumentFingerprint(source),
    status: record.snapshot?.status ?? "",
    suspendedSteps,
  };
}

/**
 * Bounds a promise so a deadlocked recovery fallback fails the test with a
 * precise message instead of hanging until the Jest timeout.
 */
async function within<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} did not settle within ${ms}ms: the run-handle recovery fallback deadlocked`
          )
        ),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

liveDescribe("mastra resume without host getRun (SAA-926 §6.3)", () => {
  beforeEach(async () => {
    await purgeLiveRuns(
      sharedLiveStorage(),
      [RUN_ID, SEED_RUN_ID],
      ["mastra-it-human-approval"]
    );
  });

  afterAll(async () => {
    await purgeLiveRuns(
      sharedLiveStorage(),
      [RUN_ID, SEED_RUN_ID],
      ["mastra-it-human-approval"]
    );
    await closeLiveStores();
  });

  it("recovers a suspended run from storage and completes it after a runtime replacement", async () => {
    const source = integrationHumanApprovalDocument();
    const storage = createLiveStorage("as-graph-it-recovery");

    await suspendAndDiscard(source, storage);
    const snapshot = await snapshotFromStorage(storage, source);

    // Process restart: a new runtime over the same durable storage, with no
    // process-side run handle and no public `getRun` on @mastra/core 1.77.0.
    const { compiled } = compileDocument(source, []);
    const restarted = runtimeOver(storage, compiled.workflow, source.id);
    expect(
      (restarted as unknown as Record<string, unknown>)["getRun"]
    ).toBeUndefined();

    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: restarted,
      suspendStateReader: {
        readRunState: async (runId: string) =>
          runId === RUN_ID ? snapshot : undefined,
      },
    });
    // Registers the canonical document + binds the compiled workflow on the
    // restarted runtime, exactly like the host boot path; it must not touch
    // the suspended RUN_ID snapshot.
    const seed = frameSinkHarness(SEED_RUN_ID);
    await backend.execute({
      document: source,
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: seed.sink,
    });

    const audit = await within(
      backend.resume(RUN_ID, {
        step: "approve",
        resumeData: { approved: true },
      }),
      5000,
      "backend.resume recovery path"
    );

    expect(audit.runId).toBe(RUN_ID);
    expect(audit.workflowId).toBe(source.id);
    expect(audit.step).toBe("approve");
    expect(audit).not.toHaveProperty("resumeData");

    // The recovered run completed for real in Mastra's own storage.
    const completed = await persistedRecord(storage);
    expect(completed.snapshot?.status).toBe("success");
    expect(completed.workflowName).toBe(source.id);
    const rows = await liveCount(
      storage,
      "SELECT count(*)::int AS count FROM \"mastra\".mastra_workflow_snapshot WHERE run_id = $1 AND snapshot->>'status' = $2",
      [RUN_ID, "success"]
    );
    expect(rows).toBe(1);
  }, 20000);
});
