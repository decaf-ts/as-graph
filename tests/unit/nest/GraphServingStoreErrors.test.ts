/**
 * @module as-graph/tests/unit/nest/GraphServingStoreErrors.test
 * @summary SAA-93 F4 regression coverage for store-error propagation and the
 * corrupt-date guard.
 * @description Direct unit coverage for the two SAA-93 F4 service-level
 * hardening changes:
 * - `toIsoDateString` returns `undefined` for an invalid/non-finite `Date`
 *   instead of throwing;
 * - `GraphWorkflowService.listWorkflows` propagates a store failure instead of
 *   swallowing it as `[]`;
 * - `GraphRunModelService.listRuns` propagates a store failure instead of
 *   swallowing it as `[]`.
 *
 * The services are instantiated on a booted Ram persistence adapter (the same
 * wiring `GraphWorkflowPersistence` uses) and the underlying store calls
 * (`listBy`/`findBy`) are stubbed to reject, so the assertion is exactly
 * "the failure surfaces", not "the list is empty".
 */
import { describe, beforeAll, it, expect } from "@jest/globals";
import { Context, PersistenceService } from "@decaf-ts/core";
import { RamAdapter } from "@decaf-ts/core/ram";

import { GraphWorkflowService } from "../../../src/engine/services/GraphWorkflowService";
import { GraphRunModelService } from "../../../src/engine/services/GraphRunModelService";
import { GraphEnvironment } from "../../../src/engine/services/GraphEnvironment";
import { toIsoDateString } from "../../../src/nest/graph/servingDates";

RamAdapter.decoration();

describe("Graph serving corrupt-date guard (SAA-93 F4)", () => {
  it("1. toIsoDateString returns undefined for an invalid/non-finite Date instead of throwing", () => {
    expect(toIsoDateString(new Date("nope"))).toBeUndefined();
    expect(toIsoDateString(new Date(NaN))).toBeUndefined();
    expect(toIsoDateString(new Date(Infinity))).toBeUndefined();
    // the healthy paths are unchanged
    expect(toIsoDateString(new Date("2026-01-01T12:00:00Z"))).toBe(
      "2026-01-01T12:00:00.000Z"
    );
    expect(toIsoDateString(null)).toBeUndefined();
    expect(toIsoDateString(undefined)).toBeUndefined();
  });
});

describe("Graph serving store-error propagation (SAA-93 F4)", () => {
  let workflowService: GraphWorkflowService;
  let runModelService: GraphRunModelService;

  beforeAll(async () => {
    const persistence = new PersistenceService();
    await persistence.boot([[RamAdapter, { UUID: "root" }]] as never);
    GraphEnvironment.accumulate({
      graph: { workflows: { allowAnonymousAccess: true } },
    } as never);
    workflowService = new GraphWorkflowService();
    runModelService = new GraphRunModelService();
  });

  it("2. listWorkflows propagates a store failure instead of swallowing it as []", async () => {
    const spy = jest
      .spyOn(workflowService, "listBy")
      .mockRejectedValue(new Error("workflow store down") as never);
    await expect(
      workflowService.listWorkflows(new Context())
    ).rejects.toThrow("workflow store down");
    spy.mockRestore();
  });

  it("3. listRuns propagates a store failure instead of swallowing it as []", async () => {
    const spy = jest
      .spyOn(runModelService, "findBy")
      .mockRejectedValue(new Error("run store down") as never);
    await expect(
      runModelService.listRuns("wf-1", new Context())
    ).rejects.toThrow("run store down");
    spy.mockRestore();
  });
});
