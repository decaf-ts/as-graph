/**
 * @module as-graph/tests/unit/nest/GraphWriteOwnership.test
 * @summary SAA-105 R3: fails-before/passes-after coverage for the strict
 * owner-equality write gate on the graph run and workflow write paths.
 * @description Pins the CTO decision that write authorization on graph
 * resources is strict owner equality while `allowAnonymousAccess` stays a
 * read-visibility tolerance:
 * - {@link GraphRunService.cancelRun}: owner-less run + owner-less caller is
 *   allowed (regression guard); owner-less run + named caller is `ForbiddenError`
 *   (fails before the gate, passes after); owned run + owner is allowed; owned
 *   run + anonymous caller with `allowAnonymousAccess` is `ForbiddenError`;
 * - {@link GraphWorkflowService.saveDocument} / `saveSnapshot`: an owner-less
 *   existing row overwritten by a named caller is `ForbiddenError`, an owner-less
 *   caller overwrite stays green, and a fresh create is unchanged for any caller;
 * - the read path keeps the owner-less visibility contract: a named caller can
 *   still read an owner-less run.
 */
import { describe, beforeAll, it, expect } from "@jest/globals";
import { Context, ForbiddenError, PersistenceService } from "@decaf-ts/core";
import { RamAdapter } from "@decaf-ts/core/ram";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphRunService } from "../../../src/engine/runs/GraphRunService";
import type {
  GraphRun,
  GraphRunEventStore,
  GraphRunStore,
} from "../../../src/engine/runs/types";
import { GraphWorkflowService } from "../../../src/engine/services/GraphWorkflowService";
import { GraphEnvironment } from "../../../src/engine/services/GraphEnvironment";
import {
  documentEdge,
  documentNode,
  documentPort,
} from "../graph/engine-fixtures";

RamAdapter.decoration();

function userContext(user: string): Context {
  const ctx = new Context();
  return ctx.accumulate({ user, timestamp: new Date() } as object) as Context;
}

function run(ownerUser: string | null, status: GraphRun["status"]): GraphRun {
  return {
    runId: `run-${ownerUser ?? "anon"}-${status}`,
    workflowId: "wf-1",
    ownerUser,
    status,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Builds a {@link GraphRunService} over an in-memory run store so the write
 * gate can be exercised without the nest HTTP harness. A non-terminal status
 * drives the real cancel path; the run store records the saved row.
 */
function runServiceWith(
  seed: GraphRun,
  options: { allowAnonymousAccess?: boolean } = {}
): { service: GraphRunService; saved: GraphRun[] } {
  const saved: GraphRun[] = [];
  const store = {
    saveRun: async (value: GraphRun) => {
      saved.push({ ...value });
    },
    readRun: async (runId: string) =>
      runId === seed.runId ? { ...seed } : null,
    listRuns: async () => [],
  } as unknown as GraphRunStore;
  const service = new GraphRunService(
    undefined as never,
    store,
    {} as GraphRunEventStore,
    options
  );
  return { service, saved };
}

function wireDocument(workflowId: string): GraphWorkflowDocument {
  return {
    id: workflowId,
    name: workflowId,
    inputs: [documentPort("brief")],
    outputs: [documentPort("summary")],
    nodes: [documentNode("n1", "core.transform", { value: "start" })],
    edges: [
      documentEdge("re0", ["workflow", "brief"], ["node", "n1", "value"]),
      documentEdge("re1", ["node", "n1", "out"], ["workflow", "summary"]),
    ],
  };
}

async function expectForbidden(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (error) {
    caught = error;
  }
  expect(resolved).toBe(false);
  expect(caught).toBeInstanceOf(ForbiddenError);
}

describe("Graph run cancellation write gate (SAA-105 R3)", () => {
  it("1. an owner-less run is cancellable by an owner-less caller (regression guard, stays green)", async () => {
    const { service, saved } = runServiceWith(run(null, "queued"));
    const cancelled = await service.cancelRun(
      "run-anon-queued",
      null
    );
    expect(cancelled.status).toBe("cancelled");
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe("cancelled");
  });

  it("2. an owner-less run is NOT cancellable by a named caller (fails before, passes after)", async () => {
    const { service, saved } = runServiceWith(run(null, "queued"));
    await expectForbidden(service.cancelRun("run-anon-queued", "bob"));
    expect(saved).toHaveLength(0);
  });

  it("3. an owned run is cancellable by its owner", async () => {
    const { service, saved } = runServiceWith(run("alice", "queued"));
    const cancelled = await service.cancelRun("run-alice-queued", "alice");
    expect(cancelled.status).toBe("cancelled");
    expect(saved).toHaveLength(1);
  });

  it("4. an owned run is NOT cancellable by an anonymous caller even with allowAnonymousAccess (narrowed write)", async () => {
    const { service, saved } = runServiceWith(run("alice", "queued"), {
      allowAnonymousAccess: true,
    });
    await expectForbidden(service.cancelRun("run-alice-queued", null));
    expect(saved).toHaveLength(0);
  });

  it("5. the read path keeps the owner-less visibility contract: a named caller still reads an owner-less run", async () => {
    const { service } = runServiceWith(run(null, "succeeded"), {
      allowAnonymousAccess: true,
    });
    const read = await service.getRun("run-anon-succeeded", "bob");
    expect(read.runId).toBe("run-anon-succeeded");
  });
});

describe("Graph workflow overwrite write gate (SAA-105 R3)", () => {
  let service: GraphWorkflowService;

  beforeAll(async () => {
    const persistence = new PersistenceService();
    await persistence.boot([[RamAdapter, { UUID: "root" }]] as never);
    GraphEnvironment.accumulate({
      graph: { workflows: { allowAnonymousAccess: true } },
    } as never);
    service = new GraphWorkflowService();
  });

  it("6. saveDocument: an owner-less workflow is NOT overwritable by a named caller (fails before, passes after)", async () => {
    const anonymous = new Context();
    await service.saveDocument("wo-doc", wireDocument("wo-doc"), anonymous);
    await expectForbidden(
      service.saveDocument(
        "wo-doc",
        wireDocument("wo-doc"),
        userContext("alice")
      )
    );
    // the owner-less row is untouched and still readable by the anonymous caller
    expect(await service.getDocument("wo-doc", anonymous)).toEqual(
      wireDocument("wo-doc")
    );
  });

  it("7. saveDocument: an owner-less workflow is overwritable by an owner-less caller (stays green)", async () => {
    const anonymous = new Context();
    await service.saveDocument("wo-doc-anon", wireDocument("wo-doc-anon"), anonymous);
    const updated = wireDocument("wo-doc-anon");
    updated.name = "updated";
    const saved = await service.saveDocument("wo-doc-anon", updated, anonymous);
    expect(saved.name).toBe("updated");
  });

  it("8. saveDocument: a fresh create is unconditional for any caller and stamps the caller's owner", async () => {
    const byNamed = await service.saveDocument(
      "wo-fresh-alice",
      wireDocument("wo-fresh-alice"),
      userContext("alice")
    );
    expect(byNamed.owner).toBe("alice");

    const byAnonymous = await service.saveDocument(
      "wo-fresh-anon",
      wireDocument("wo-fresh-anon"),
      new Context()
    );
    expect(byAnonymous.owner ?? null).toBeNull();
  });

  it("9. saveSnapshot: an owner-less workflow is NOT overwritable by a named caller", async () => {
    const anonymous = new Context();
    const wrapper = { document: wireDocument("ws-snap") };
    await service.saveSnapshot("ws-snap", wrapper, anonymous);
    await expectForbidden(
      service.saveSnapshot("ws-snap", wrapper, userContext("alice"))
    );
    expect((await service.loadSnapshot("ws-snap", anonymous))?.snapshot).toEqual(
      wrapper
    );
  });

  it("10. saveSnapshot: an owner-less workflow is overwritable by an owner-less caller (stays green)", async () => {
    const anonymous = new Context();
    const wrapper = { document: wireDocument("ws-snap-anon") };
    await service.saveSnapshot("ws-snap-anon", wrapper, anonymous);
    const saved = await service.saveSnapshot(
      "ws-snap-anon",
      wrapper,
      anonymous
    );
    expect(saved.snapshot).toEqual(wrapper);
  });

  it("11. saveDocument/saveSnapshot: an owned workflow is NOT overwritable by an anonymous caller with allowAnonymousAccess (narrowed write)", async () => {
    const alice = userContext("alice");
    await service.saveDocument("wo-owned", wireDocument("wo-owned"), alice);
    await expectForbidden(
      service.saveDocument("wo-owned", wireDocument("wo-owned"), new Context())
    );
    await expectForbidden(
      service.saveSnapshot(
        "wo-owned",
        { document: wireDocument("wo-owned") },
        new Context()
      )
    );
  });
});
