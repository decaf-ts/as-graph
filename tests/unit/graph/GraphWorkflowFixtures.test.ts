/**
 * @module as-graph/tests/unit/graph/GraphWorkflowFixtures.test
 * @summary SAA-2049 evidence: the engine-neutral (basic) demo workflow fixture
 * registry covers every basic node kind and every node-config combination, and
 * every fixture passes the persistence boundary gate.
 * @description SAA-1549 split the old single registry into the `basic/` set
 * (engine-neutral, seeded by the local/general engine) and the `mastra/` set
 * (Mastra-owned kinds, seeded only by the Mastra boot variant). This suite now
 * asserts the basic set only; the Mastra set is covered by
 * `MastraFixtureRegistry.test.ts`.
 */
import { describe, it, expect } from "@jest/globals";
import { Context } from "@decaf-ts/core";
import { GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND } from "../../../src/node";
import { validateGraphWorkflowDocumentAtBoundary } from "../../../src/engine/validation/GraphWorkflowBoundaryValidation";
import {
  ALL_BASIC_NODE_KINDS,
  ALL_CONFIG_COMBOS,
  basicWorkflowFixtures,
  buildBasicFixtureMatrix,
  uncoveredBasicKinds,
} from "../../../src/workflows";

describe("demo workflow fixture registry (SAA-2049)", () => {
  it("covers every one of the 21 basic node kinds", () => {
    const covered = new Set(basicWorkflowFixtures.flatMap((f) => f.kinds));
    for (const kind of ALL_BASIC_NODE_KINDS) {
      expect(covered.has(kind)).toBe(true);
    }
    expect(ALL_BASIC_NODE_KINDS).toHaveLength(21);
    expect(uncoveredBasicKinds()).toEqual([]);
  });

  it("covers every config combination in at least one fixture", () => {
    const covered = new Set(basicWorkflowFixtures.flatMap((f) => f.combos));
    for (const combo of ALL_CONFIG_COMBOS) {
      expect(covered.has(combo)).toBe(true);
    }
    expect(ALL_CONFIG_COMBOS).toHaveLength(6);
  });

  it("registers the boundary value/result kinds in the built-in catalogue", () => {
    const registered = Object.keys(GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND);
    expect(registered).toContain("value");
    expect(registered).toContain("result");
    const fixtureKinds = new Set(basicWorkflowFixtures.flatMap((f) => f.kinds));
    expect(fixtureKinds.has("value")).toBe(true);
    expect(fixtureKinds.has("result")).toBe(true);
  });

  it("derives a node→workflow→combo matrix with no uncovered kind", () => {
    const matrix = buildBasicFixtureMatrix();
    for (const kind of ALL_BASIC_NODE_KINDS) {
      expect(matrix[kind].workflows.length).toBeGreaterThan(0);
      expect(matrix[kind].combos.length).toBeGreaterThan(0);
    }
  });

  it("passes the persistence boundary gate for every fixture", async () => {
    for (const fixture of basicWorkflowFixtures) {
      const result = await validateGraphWorkflowDocumentAtBoundary(
        fixture.document,
        {},
        new Context()
      );
      expect({ id: fixture.id, valid: result.valid, issues: result.issues }).toEqual(
        { id: fixture.id, valid: true, issues: [] }
      );
    }
  });
});
