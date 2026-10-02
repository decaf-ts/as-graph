/**
 * @module as-graph/tests/unit/graph/GraphWorkflowFixtures.test
 * @summary SAA-2049 evidence: the persisted demo workflow fixture registry
 * covers every built-in node kind and every node-config combination, and every
 * fixture passes the persistence boundary gate.
 */
import { describe, it, expect } from "@jest/globals";
import { Context } from "@decaf-ts/core";
import {
  GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND,
} from "../../../src/node";
import { validateGraphWorkflowDocumentAtBoundary } from "../../../src/engine/validation/GraphWorkflowBoundaryValidation";
import {
  ALL_BUILT_IN_NODE_KINDS,
  ALL_CONFIG_COMBOS,
  buildFixtureMatrix,
  graphWorkflowFixtures,
} from "../../fixtures/workflows";

describe("demo workflow fixture registry (SAA-2049)", () => {
  it("covers every one of the 22 built-in node kinds", () => {
    const covered = new Set(graphWorkflowFixtures.flatMap((f) => f.kinds));
    for (const kind of ALL_BUILT_IN_NODE_KINDS) {
      expect(covered.has(kind)).toBe(true);
    }
    expect(ALL_BUILT_IN_NODE_KINDS).toHaveLength(22);
  });

  it("covers every config combination in at least one fixture", () => {
    const covered = new Set(graphWorkflowFixtures.flatMap((f) => f.combos));
    for (const combo of ALL_CONFIG_COMBOS) {
      expect(covered.has(combo)).toBe(true);
    }
    expect(ALL_CONFIG_COMBOS).toHaveLength(6);
  });

  it("registers the boundary value/result kinds in the built-in catalogue", () => {
    const registered = Object.keys(GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND);
    expect(registered).toContain("value");
    expect(registered).toContain("result");
    const fixtureKinds = new Set(graphWorkflowFixtures.flatMap((f) => f.kinds));
    expect(fixtureKinds.has("value")).toBe(true);
    expect(fixtureKinds.has("result")).toBe(true);
  });

  it("derives a node→workflow→combo matrix with no uncovered kind", () => {
    const matrix = buildFixtureMatrix();
    for (const kind of ALL_BUILT_IN_NODE_KINDS) {
      expect(matrix[kind].workflows.length).toBeGreaterThan(0);
      expect(matrix[kind].combos.length).toBeGreaterThan(0);
    }
  });

  it("passes the persistence boundary gate for every fixture", async () => {
    for (const fixture of graphWorkflowFixtures) {
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
