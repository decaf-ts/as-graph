/**
 * @module as-graph/tests/unit/graph/GraphWorkflowSeedDocument.test
 * @summary SAA-804 (from SAA-798) F2 verification: the boot-seed write surface
 * `GraphWorkflowService.seedDocument` tolerates a foreign-owned row (skip + log)
 * while the request-path write `GraphWorkflowService.saveDocument` stays
 * fail-closed on the same row.
 * @description Behavioural checks, not implementation checks:
 * - F2.1 `seedDocument(id, doc)` over a row already owned by a DIFFERENT user
 *   resolves `null` (skip) and does not throw, leaving the row untouched;
 * - F2.2 `saveDocument(id, doc)` (the request path) on that same foreign-owned
 *   row still throws `ForbiddenError`, even for an anonymous caller under the
 *   `allowAnonymousAccess` read tolerance — the read tolerance never grants a
 *   write (SAA-105 R3).
 */
import { describe, beforeAll, afterEach, it, expect, jest } from "@jest/globals";
import { Context, ForbiddenError, PersistenceService } from "@decaf-ts/core";
import { RamAdapter } from "@decaf-ts/core/ram";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphWorkflowService } from "../../../src/engine/services/GraphWorkflowService";
import { GraphEnvironment } from "../../../src/engine/services/GraphEnvironment";
import {
  documentEdge,
  documentNode,
  documentPort,
} from "./engine-fixtures";

RamAdapter.decoration();

/** A decaf `Context` carrying the authenticated `user`, mirroring the auth handler. */
function userContext(user: string): Context {
  const ctx = new Context();
  return ctx.accumulate({ user, timestamp: new Date() } as object) as Context;
}

/** A minimal but valid canonical workflow document with the given id. */
function wireDocument(workflowId: string, name = workflowId): GraphWorkflowDocument {
  return {
    id: workflowId,
    name,
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

describe("GraphWorkflowService.seedDocument boot-seed availability (SAA-798 F2)", () => {
  let service: GraphWorkflowService;

  beforeAll(async () => {
    const persistence = new PersistenceService();
    await persistence.boot([[RamAdapter, { UUID: "root" }]] as never);
    GraphEnvironment.accumulate({
      graph: { workflows: { allowAnonymousAccess: true } },
    } as never);
    service = new GraphWorkflowService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("F2.1 seedDocument resolves null (skip, no throw) for a foreign-owned row and leaves it untouched", async () => {
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation((() => undefined) as never);
    const original = wireDocument("seed-foreign");
    await service.saveDocument("seed-foreign", original, userContext("alice"));

    const seeded = await service.seedDocument(
      "seed-foreign",
      wireDocument("seed-foreign", "overwritten"),
      userContext("bob")
    );

    expect(seeded).toBeNull();
    // The foreign-owned row is never overwritten: still alice's original document.
    const stored = await service.getDocument("seed-foreign", userContext("alice"));
    expect(stored).toEqual(original);

    // The skip is logged (the operator-visible "skip-log" of the F2 fix).
    const lines = warn.mock.calls
      .map((call) => call.map((arg) => String(arg)).join(" "))
      .join("\n");
    expect(lines).toContain("Skipping boot seed");
    expect(lines).toContain("seed-foreign");
  });

  it("F2.1 seedDocument still seeds an unowned/fresh id (happy path unchanged)", async () => {
    const doc = wireDocument("seed-fresh");
    const seeded = await service.seedDocument("seed-fresh", doc, new Context());
    expect(seeded).not.toBeNull();
    expect((seeded as { workflowId: string }).workflowId).toBe("seed-fresh");
    expect(await service.getDocument("seed-fresh", new Context())).toEqual(doc);
  });

  it("F2.2 saveDocument on the foreign-owned row still throws ForbiddenError (fail-closed)", async () => {
    await service.saveDocument(
      "write-foreign",
      wireDocument("write-foreign"),
      userContext("alice")
    );

    // A different named caller cannot overwrite it…
    await expectForbidden(
      service.saveDocument(
        "write-foreign",
        wireDocument("write-foreign", "bob-write"),
        userContext("bob")
      )
    );
    // …and the read tolerance (allowAnonymousAccess) never grants the write.
    await expectForbidden(
      service.saveDocument(
        "write-foreign",
        wireDocument("write-foreign", "anon-write"),
        new Context()
      )
    );

    // The row is unchanged after both rejected writes.
    expect(
      await service.getDocument("write-foreign", userContext("alice"))
    ).toEqual(wireDocument("write-foreign"));
  });
});
