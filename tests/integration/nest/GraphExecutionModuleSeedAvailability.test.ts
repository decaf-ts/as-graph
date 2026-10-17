/**
 * @module as-graph/tests/integration/nest/GraphExecutionModuleSeedAvailability
 * @summary SAA-804 (from SAA-798) F2 verification at integration level: booting
 * {@link GraphExecutionModule} with a `seedWorkflows` catalogue over a store that
 * already holds a user-owned row for a seed id must NOT reject the async
 * bootstrap — the module seeds through the tolerant `seedDocument` surface.
 * @description A durable store that already owns a fixture id as a user-owned row
 * is modelled with a host-configured adapter (the durable-store case). The
 * tolerant boot factory is exercised exactly as the module wires it: the
 * `GraphWorkflowService` provider factory calls `seedDocument`, which skips the
 * foreign-owned id and logs, instead of failing closed. The same collision is
 * proven fatal on the request path (`saveDocument`) so the test pins that the
 * module is relying on the tolerant surface, not on the collision not existing.
 *
 * Note: `initAdapter: true` installs a *fresh* in-process RamAdapter, so a
 * pre-existing row cannot coexist with it (a second RamAdapter registration
 * throws, and a fresh adapter starts empty). A durable store is exactly the
 * host-configured-adapter case exercised here; the module's seed code path is
 * identical.
 */
import { describe, beforeAll, afterAll, it, expect } from "@jest/globals";
import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { Context, PersistenceService } from "@decaf-ts/core";
import { ForbiddenError } from "@decaf-ts/core";
import { RamAdapter } from "@decaf-ts/core/ram";

import { GraphExecutionModule } from "../../../src/nest/graph";
import { GraphWorkflowService } from "../../../src/engine/services/GraphWorkflowService";
import { GraphEnvironment } from "../../../src/engine/services/GraphEnvironment";
import { graphWorkflowFixtures } from "../../../src/workflows";

RamAdapter.decoration();

/** A decaf `Context` carrying the authenticated `user`. */
function userContext(user: string): Context {
  const ctx = new Context();
  return ctx.accumulate({ user, timestamp: new Date() } as object) as Context;
}

describe("GraphExecutionModule boot-seed availability (SAA-798 F2)", () => {
  const fixtureIds = graphWorkflowFixtures
    .map((fixture) => fixture.document.id)
    .sort();
  const foreignFixture = graphWorkflowFixtures[0];
  const foreignId = foreignFixture.document.id;
  const foreignDocument = { ...foreignFixture.document, name: "user-owned" };

  let app: INestApplication;
  let moduleRef: TestingModule;
  let bootedService: GraphWorkflowService;

  beforeAll(async () => {
    const persistence = new PersistenceService();
    await persistence.boot([[RamAdapter, { UUID: "root" }]] as never);
    GraphEnvironment.accumulate({
      graph: { workflows: { allowAnonymousAccess: true } },
    } as never);

    // Pre-existing user-owned row for a seed id, as a durable store would hold.
    const preExisting = new GraphWorkflowService();
    await preExisting.saveDocument(
      foreignId,
      foreignDocument,
      userContext("alice")
    );

    // The request path over the same row still fails closed (SAA-105 R3): the
    // module must therefore rely on the tolerant seed surface, not on absence.
    await expect(
      preExisting.saveDocument(
        foreignId,
        foreignFixture.document,
        new Context()
      )
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Boot the module over the host-configured adapter with the fixture seeds.
    moduleRef = await Test.createTestingModule({
      imports: [
        GraphExecutionModule.forRoot({
          seedWorkflows: graphWorkflowFixtures.map(
            (fixture) => fixture.document
          ),
          workflows: { auth: "optional", allowAnonymousAccess: true },
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    bootedService = moduleRef.get(GraphWorkflowService);
  }, 30000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      // already closed
    }
  }, 15000);

  it("bootstrap resolves (does not reject) with a pre-existing user-owned seed id", () => {
    expect(moduleRef).toBeDefined();
    expect(app).toBeDefined();
    expect(bootedService).toBeInstanceOf(GraphWorkflowService);
  });

  it("leaves the foreign-owned row untouched (still owned by alice)", async () => {
    const stored = await bootedService.getDocument(
      foreignId,
      userContext("alice")
    );
    expect(stored).toEqual(foreignDocument);
  });

  it("still seeds the fixture ids not already owned by another user", async () => {
    const listed = (await bootedService.listWorkflows(new Context())).map(
      (model) => model.workflowId
    );
    for (const id of fixtureIds) {
      expect(listed).toContain(id);
    }
  });
});
