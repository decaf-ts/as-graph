/**
 * @module as-graph/tests/unit/graph/GraphRunResume.test
 * @summary SAA-205 driver tests for {@link GraphRunService.resumeRun}
 * (SAA-196 C14): the owner-equality write gate, the fail-closed
 * unsupported-backend path, the SAA-200 no-details sanitization, the C18
 * `WORKFLOW_RESUMED` audit envelope, and the NotFound ordering.
 * @description Drives the run service directly (engine-level, no HTTP) with a
 * stub {@link GraphExecutionBackend} so each branch of the resume path is
 * asserted in isolation:
 * 1. an owner resumes: the stub backend's `resume` receives the exact `runId` +
 *    request and the returned audit carries `caller === owner`;
 * 2. a non-owner, a named caller on an owner-less run, and an anonymous caller
 *    on an owned run are all rejected with `ForbiddenError` and the backend's
 *    `resume` is never invoked (even with the read tolerance
 *    `allowAnonymousAccess` set);
 * 3. an active backend without `resume` fails closed with a
 *    `GraphExecutionError` `GRAPH_RESUME_UNSUPPORTED_BACKEND` and publishes no
 *    audit event;
 * 4. a backend-thrown `GraphExecutionError(message, graphCode, details)` is
 *    re-thrown without `details`, preserving `message`/`graphCode` (SAA-200);
 * 5. a successful resume publishes exactly one `WORKFLOW_RESUMED` envelope whose
 *    payload carries `caller`/`runId`/`step`/`resumeDataHash`/`resumeDataBytes`
 *    and never the raw `resumeData`;
 * 6. an unknown `runId` throws `NotFoundError` before ownership or backend
 *    access.
 */
import { describe, it, expect } from "@jest/globals";
import { ForbiddenError } from "@decaf-ts/core";
import { NotFoundError } from "@decaf-ts/db-decorators";
import type { GraphExecutionResult } from "../../../src/engine/types";
import type { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import type {
  GraphCodeMode,
  GraphExecutionBackend,
  GraphResumeAudit,
  GraphResumeRequest,
} from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphExecutionError } from "../../../src/engine/errors";
import { GraphRunService } from "../../../src/engine/runs/GraphRunService";
import { InMemoryGraphRunEventStore } from "../../../src/engine/runs/InMemoryGraphRunEventStore";
import type {
  GraphRun,
  GraphRunStore,
} from "../../../src/engine/runs/types";
import { GraphExecutionEventType } from "../../../src/shared/graph";

/** A resume-capable stub backend that records the resume calls it receives. */
class StubResumeBackend implements GraphExecutionBackend {
  readonly local = true;
  readonly codeMode: GraphCodeMode = "hostSide";
  readonly resumeCalls: Array<{
    runId: string;
    request: GraphResumeRequest;
  }> = [];
  private readonly impl: (
    runId: string,
    request: GraphResumeRequest
  ) => Promise<GraphResumeAudit>;

  constructor(
    impl?: (runId: string, request: GraphResumeRequest) => Promise<GraphResumeAudit>
  ) {
    this.impl =
      impl ??
      (async (runId, request) => ({
        runId,
        step: request.step,
        resumeDataHash: "stub-hash",
        resumeDataBytes: 2,
      }));
  }

  async initialize(): Promise<void> {}

  async execute(): Promise<GraphExecutionResult> {
    throw new GraphExecutionError("execute is not exercised by resume tests");
  }

  async resume(
    runId: string,
    request: GraphResumeRequest
  ): Promise<GraphResumeAudit> {
    this.resumeCalls.push({ runId, request });
    return this.impl(runId, request);
  }
}

/** An active backend that does not expose the optional `resume` extension. */
class NoResumeBackend implements GraphExecutionBackend {
  readonly local = true;
  readonly codeMode: GraphCodeMode = "hostSide";

  async initialize(): Promise<void> {}

  async execute(): Promise<GraphExecutionResult> {
    throw new GraphExecutionError("execute is not exercised by resume tests");
  }
}

/** Builds a run record owned by `ownerUser`. */
function makeRun(ownerUser: string | null): GraphRun {
  return {
    runId: `run-${ownerUser ?? "anon"}`,
    workflowId: "wf-resume",
    ownerUser,
    status: "running",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Builds a {@link GraphRunService} over a seeded in-memory run store and event
 * store, with the given backend exposed through a minimal engine double. The
 * service only reads `engine.backend` on the resume path, so the double carries
 * exactly that.
 */
function buildService(
  backend: GraphExecutionBackend,
  run: GraphRun,
  options: { allowAnonymousAccess?: boolean } = {}
): { service: GraphRunService; events: InMemoryGraphRunEventStore } {
  const store = {
    saveRun: async () => undefined,
    readRun: async (runId: string) => (runId === run.runId ? { ...run } : null),
    listRuns: async () => [],
  } as unknown as GraphRunStore;
  const events = new InMemoryGraphRunEventStore();
  const engine = { backend } as unknown as GraphExecutionEngine;
  const service = new GraphRunService(engine, store, events, options);
  return { service, events };
}

/** Captures the rejection of a promise, asserting it did reject. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  let caught: unknown;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (error) {
    caught = error;
  }
  expect(resolved).toBe(false);
  return caught;
}

describe("GraphRunService.resumeRun (SAA-196 C14)", () => {
  it("1. owner-equality gate allows the owner and delegates the exact runId + request", async () => {
    const backend = new StubResumeBackend();
    const run = makeRun("alice");
    const { service } = buildService(backend, run);
    const request: GraphResumeRequest = {
      step: "approval",
      resumeData: { approved: true },
    };

    const audit = await service.resumeRun(run.runId, request, "alice");

    expect(backend.resumeCalls).toHaveLength(1);
    expect(backend.resumeCalls[0].runId).toBe(run.runId);
    expect(backend.resumeCalls[0].request).toBe(request);
    expect(audit.caller).toBe("alice");
    expect(audit.runId).toBe(run.runId);
  });

  it("2a. a non-owner is rejected with ForbiddenError and the backend is never invoked", async () => {
    const backend = new StubResumeBackend();
    const run = makeRun("alice");
    const { service } = buildService(backend, run);

    const caught = await captureRejection(
      service.resumeRun(run.runId, { step: "s1" }, "bob")
    );
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(backend.resumeCalls).toHaveLength(0);
  });

  it("2b. a named caller on an owner-less run is rejected with ForbiddenError", async () => {
    const backend = new StubResumeBackend();
    const run = makeRun(null);
    const { service } = buildService(backend, run, {
      allowAnonymousAccess: true,
    });

    const caught = await captureRejection(
      service.resumeRun(run.runId, { step: "s1" }, "bob")
    );
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(backend.resumeCalls).toHaveLength(0);
  });

  it("2c. an anonymous caller on an owned run is rejected even with allowAnonymousAccess", async () => {
    const backend = new StubResumeBackend();
    const run = makeRun("alice");
    const { service } = buildService(backend, run, {
      allowAnonymousAccess: true,
    });

    const caught = await captureRejection(
      service.resumeRun(run.runId, { step: "s1" }, null)
    );
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(backend.resumeCalls).toHaveLength(0);
  });

  it("3. a backend without resume fails closed with GRAPH_RESUME_UNSUPPORTED_BACKEND and publishes no event", async () => {
    const backend = new NoResumeBackend();
    const run = makeRun("alice");
    const { service, events } = buildService(backend, run);

    const caught = await captureRejection(
      service.resumeRun(run.runId, { step: "s1" }, "alice")
    );
    expect(caught).toBeInstanceOf(GraphExecutionError);
    expect((caught as GraphExecutionError).graphCode).toBe(
      "GRAPH_RESUME_UNSUPPORTED_BACKEND"
    );
    expect(await events.listAfter(run.runId, 0)).toHaveLength(0);
  });

  it("4. a backend GraphExecutionError is re-thrown without details, preserving message and graphCode", async () => {
    const backendError = new GraphExecutionError(
      "resume rejected by backend",
      "GRAPH_RESUME_BACKEND_FAILED",
      { internalState: "server-side-secret" }
    );
    const backend = new StubResumeBackend(async () => {
      throw backendError;
    });
    const run = makeRun("alice");
    const { service, events } = buildService(backend, run);

    const caught = await captureRejection(
      service.resumeRun(run.runId, { step: "s1" }, "alice")
    );
    expect(caught).toBeInstanceOf(GraphExecutionError);
    const error = caught as GraphExecutionError;
    expect(error).not.toBe(backendError);
    // `sanitizeResumeError` rebuilds from `error.message`; the Decaf formatter
    // re-prefixes the rebuilt error, so the original formatted message is fully
    // preserved as the trailing content of the re-thrown message.
    expect(error.message.endsWith(backendError.message)).toBe(true);
    expect(error.message).toContain("resume rejected by backend");
    expect(error.graphCode).toBe("GRAPH_RESUME_BACKEND_FAILED");
    expect(error.details).toBeUndefined();
    expect(await events.listAfter(run.runId, 0)).toHaveLength(0);
  });

  it("5. a successful resume publishes exactly one C18 WORKFLOW_RESUMED envelope without the raw resumeData", async () => {
    const secret = "raw-resume-payload-must-not-leak";
    const backend = new StubResumeBackend(async (runId, request) => ({
      runId,
      step: request.step,
      resumeDataHash: "sha256-deadbeef",
      resumeDataBytes: 42,
    }));
    const run = makeRun("alice");
    const { service, events } = buildService(backend, run);
    const request: GraphResumeRequest = {
      step: "approval",
      resumeData: { secret },
    };

    const audit = await service.resumeRun(run.runId, request, "alice");
    expect(audit.step).toBe("approval");

    const published = await events.listAfter(run.runId, 0);
    expect(published).toHaveLength(1);
    const envelope = published[0];
    expect(envelope.type).toBe(GraphExecutionEventType.WORKFLOW_RESUMED);
    expect(envelope.runId).toBe(run.runId);
    expect(envelope.workflowId).toBe(run.workflowId);

    const payload = envelope.payload as Record<string, unknown>;
    expect(payload.caller).toBe("alice");
    expect(payload.runId).toBe(run.runId);
    expect(payload.step).toBe("approval");
    expect(payload.resumeDataHash).toBe("sha256-deadbeef");
    expect(payload.resumeDataBytes).toBe(42);
    expect(JSON.stringify(envelope)).not.toContain(secret);
  });

  it("6. an unknown runId throws NotFoundError before ownership or backend access", async () => {
    const backend = new StubResumeBackend();
    const run = makeRun("alice");
    const { service, events } = buildService(backend, run);

    const caught = await captureRejection(
      service.resumeRun("does-not-exist", { step: "s1" }, "bob")
    );
    expect(caught).toBeInstanceOf(NotFoundError);
    expect(backend.resumeCalls).toHaveLength(0);
    expect(await events.listAfter("does-not-exist", 0)).toHaveLength(0);
  });
});
