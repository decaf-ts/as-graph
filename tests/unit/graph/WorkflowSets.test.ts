/**
 * @module as-graph/tests/unit/graph/WorkflowSets.test
 * @summary SAA-1545 §7 "Workflow sets" regression: the basic registry is
 * engine-neutral and complete, the Mastra registry targets every Mastra kind
 * with a deterministic capability matrix, and the boot loader selects exactly
 * one set per engine variant.
 * @description Covers the split introduced by SAA-1549: no basic fixture may
 * carry a Mastra-dependent kind, both sets stay JSON-safe and id-disjoint, every
 * `MASTRA_NODE_CLASSES_BY_KIND` key and every `MASTRA_FEATURE_CAPABILITIES` row
 * has explicit evidence, and `loadGraphDemoWorkflows(variant)` returns the
 * selected set (empty for dagster).
 */
import { describe, it, expect } from "@jest/globals";

import { graphNodeRequiresMastraEngine } from "../../../src/engine/execution/GraphNodeEngineRequirements";
import { MASTRA_NODE_CLASSES_BY_KIND } from "../../../src/mastra/nodes/classes";
import { MASTRA_NODE_MANIFESTS_BY_KIND } from "../../../src/mastra/nodes/manifests";
import { MASTRA_FEATURE_CAPABILITIES } from "../../../src/mastra/MastraCapabilities";
import {
  ALL_BASIC_NODE_KINDS,
  ALL_CONFIG_COMBOS,
  basicWorkflowFixtures,
} from "../../../src/workflows";
import {
  ALL_MASTRA_NODE_KINDS,
  MASTRA_CONFORMANCE_SCENARIOS,
  assertMastraFixtureCoverage,
  buildMastraCapabilityCoverage,
  mastraFixtureCoverageReport,
  mastraKindFixtures,
  mastraKindFixturesByKind,
  mastraWorkflowFixtures,
  mastraWorkflowFixturesById,
  uncoveredMastraCapabilities,
  uncoveredMastraKindFixtures,
} from "../../../src/workflows/mastra";
import { loadGraphDemoWorkflows } from "../../../src/nest/graph/GraphBackendHost";

/**
 * Walks a fixture value and fails on anything `JSON.stringify` would drop or
 * reject, so registry metadata can never smuggle a function into a persisted
 * document.
 */
function assertJsonSafe(value: unknown, path = "fixture"): void {
  if (typeof value === "function" || typeof value === "symbol") {
    throw new Error(`${path} is a ${typeof value} (not JSON-safe)`);
  }
  if (typeof value === "bigint") {
    throw new Error(`${path} is a bigint (not JSON-safe)`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSafe(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      assertJsonSafe(entry, `${path}.${key}`);
    }
  }
}

describe("workflow sets — basic registry (SAA-1545 §7)", () => {
  it("contains no Mastra-dependent node kind", () => {
    const offending = basicWorkflowFixtures
      .flatMap((fixture) => [
        ...fixture.kinds,
        ...(fixture.targetKinds ?? []),
      ])
      .filter((kind) => graphNodeRequiresMastraEngine(kind));
    expect(offending).toEqual([]);
  });

  it("covers every basic kind and every config combo", () => {
    const kinds = new Set(basicWorkflowFixtures.flatMap((f) => f.kinds));
    expect(ALL_BASIC_NODE_KINDS).toHaveLength(21);
    expect(ALL_BASIC_NODE_KINDS.filter((kind) => !kinds.has(kind))).toEqual([]);

    const combos = new Set(basicWorkflowFixtures.flatMap((f) => f.combos));
    expect(ALL_CONFIG_COMBOS.filter((combo) => !combos.has(combo))).toEqual([]);
  });

  it("registers each fixture under its document id and keeps ids distinct from the Mastra set", () => {
    for (const fixture of basicWorkflowFixtures) {
      expect(fixture.document.id).toBe(fixture.id);
      expect(fixture.family).toBe("basic");
    }
    const basicIds = basicWorkflowFixtures.map((f) => f.id);
    const mastraIds = mastraWorkflowFixtures.map((f) => f.id);
    expect(new Set(basicIds).size).toBe(basicIds.length);
    expect(new Set(mastraIds).size).toBe(mastraIds.length);
    expect(basicIds.filter((id) => mastraIds.includes(id))).toEqual([]);
  });

  it("keeps fixture metadata and documents JSON-safe with no executable functions", () => {
    for (const fixture of basicWorkflowFixtures) {
      assertJsonSafe(fixture, fixture.id);
      expect(() => JSON.stringify(fixture)).not.toThrow();
      expect(JSON.parse(JSON.stringify(fixture.document))).toEqual(
        fixture.document
      );
    }
  });
});

describe("workflow sets — Mastra registry (SAA-1545 §7)", () => {
  it("targets every MASTRA_NODE_CLASSES_BY_KIND key explicitly", () => {
    const expected = Object.keys(MASTRA_NODE_CLASSES_BY_KIND).sort();
    expect(ALL_MASTRA_NODE_KINDS).toEqual(expected);
    expect(uncoveredMastraKindFixtures()).toEqual([]);
    const targetKinds = new Set(
      mastraWorkflowFixtures.flatMap((f) => f.targetKinds ?? [])
    );
    for (const kind of expected) {
      expect({ kind, targeted: targetKinds.has(kind) }).toEqual({
        kind,
        targeted: true,
      });
    }
  });

  it("builds one boundary-matching fixture per Mastra kind", () => {
    for (const kind of Object.keys(MASTRA_NODE_CLASSES_BY_KIND)) {
      const manifest = MASTRA_NODE_MANIFESTS_BY_KIND[kind];
      const fixture = mastraKindFixturesByKind[kind];
      expect({ kind, fixture: !!fixture }).toEqual({ kind, fixture: true });
      if (!fixture) continue;

      expect(fixture.targetKinds).toEqual([kind]);
      const inputIds = fixture.document.inputs.map((port) => port.id).sort();
      const outputIds = fixture.document.outputs.map((port) => port.id).sort();
      expect(inputIds).toEqual(
        manifest.inputs.map((port) => `in-${port.id}`).sort()
      );
      expect(outputIds).toEqual(
        manifest.outputs.map((port) => `out-${port.id}`).sort()
      );
      expect(Object.keys(fixture.inputs ?? {}).sort()).toEqual(inputIds);
    }
    expect(mastraKindFixtures).toHaveLength(
      Object.keys(MASTRA_NODE_CLASSES_BY_KIND).length
    );
  });

  it("passes the fixture coverage assertion", () => {
    expect(() => assertMastraFixtureCoverage()).not.toThrow();
    const report = mastraFixtureCoverageReport();
    expect(report.uncoveredKinds).toEqual([]);
    expect(report.uncoveredCapabilities).toEqual([]);
  });

  it("resolves every capability row to declared fixtures and scenarios (SAA-1545 §5.2)", () => {
    const fixtures = new Map<
      string,
      { family: "basic" | "mastra"; capabilities: readonly string[] }
    >();
    for (const fixture of basicWorkflowFixtures) {
      fixtures.set(fixture.id, {
        family: "basic",
        capabilities: fixture.capabilities ?? [],
      });
    }
    for (const fixture of mastraWorkflowFixtures) {
      fixtures.set(fixture.id, {
        family: "mastra",
        capabilities: fixture.capabilities ?? [],
      });
    }
    const scenarios = new Map(
      MASTRA_CONFORMANCE_SCENARIOS.map((scenario) => [scenario.id, scenario])
    );

    const matrix = buildMastraCapabilityCoverage();
    expect(matrix).toHaveLength(MASTRA_FEATURE_CAPABILITIES.length);
    expect(uncoveredMastraCapabilities()).toEqual([]);

    const problems: string[] = [];
    for (const row of matrix) {
      expect({
        feature: row.feature,
        covered: row.covered,
      }).toEqual({ feature: row.feature, covered: true });
      expect(row.fixtureIds.length + row.scenarioIds.length).toBeGreaterThan(0);

      // Contract 5: a row with no linked fixture must cite a scenario.
      if (row.fixtureIds.length === 0 && row.scenarioIds.length === 0) {
        problems.push(
          `capability '${row.feature}' has no linked fixture and no conformance scenario`
        );
      }

      for (const fixtureId of row.fixtureIds) {
        const linked = fixtures.get(fixtureId);
        if (!linked) {
          problems.push(
            `capability '${row.feature}' links unknown fixture id '${fixtureId}'`
          );
          continue;
        }
        // Contract 4: a linked Mastra fixture must declare the row itself;
        // basic fixtures are engine-neutral and may lean on a scenario.
        if (
          linked.family === "mastra" &&
          !linked.capabilities.includes(row.feature)
        ) {
          problems.push(
            `capability '${row.feature}' links ${linked.family} fixture '${fixtureId}', which does not declare that capability`
          );
        }
      }

      for (const scenarioId of row.scenarioIds) {
        const scenario = scenarios.get(scenarioId);
        if (!scenario) {
          problems.push(
            `capability '${row.feature}' links unknown scenario id '${scenarioId}'`
          );
          continue;
        }
        if (!scenario.capabilities.includes(row.feature)) {
          problems.push(
            `capability '${row.feature}' links scenario '${scenarioId}', whose capabilities [${scenario.capabilities.join(", ")}] do not declare it`
          );
        }
      }

      // Contract 3: the row must be declared by a linked fixture or scenario.
      const declaredByFixture = row.fixtureIds.some((fixtureId) =>
        (fixtures.get(fixtureId)?.capabilities ?? []).includes(row.feature)
      );
      const declaredByScenario = row.scenarioIds.some((scenarioId) =>
        (scenarios.get(scenarioId)?.capabilities ?? []).includes(row.feature)
      );
      if (!declaredByFixture && !declaredByScenario) {
        problems.push(
          `capability '${row.feature}' is not declared by any linked fixture (${row.fixtureIds.join(", ") || "none"}) or scenario (${row.scenarioIds.join(", ") || "none"})`
        );
      }
    }

    expect(problems).toEqual([]);
  });

  it("gives every unsupported capability a fail-closed code or reason", () => {
    const unsupported = MASTRA_FEATURE_CAPABILITIES.filter(
      (row) => row.verdict === "NOT-SUPPORTED"
    );
    expect(unsupported.length).toBeGreaterThan(0);
    for (const row of unsupported) {
      const scenarios = MASTRA_CONFORMANCE_SCENARIOS.filter((scenario) =>
        scenario.capabilities.includes(row.feature)
      );
      expect({ feature: row.feature, scenarios: scenarios.length }).toEqual({
        feature: row.feature,
        scenarios: expect.any(Number),
      });
      expect(scenarios.length).toBeGreaterThan(0);
      for (const scenario of scenarios) {
        expect(scenario.reason.length).toBeGreaterThan(0);
        expect(
          scenario.expectedGraphCode ?? scenario.expectedBehavior
        ).toMatch(/fail|reject|not.?support|unavailable/i);
      }
    }
  });

  it("keeps fixture ids unique across the per-kind, chat, and composite fixtures", () => {
    const ids = mastraWorkflowFixtures.map((fixture) => fixture.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
    expect(Object.keys(mastraWorkflowFixturesById).sort()).toEqual(
      [...ids].sort()
    );
  });

  it("keeps fixture metadata and documents JSON-safe with no executable functions", () => {
    for (const fixture of mastraWorkflowFixtures) {
      assertJsonSafe(fixture, fixture.id);
      expect(() => JSON.stringify(fixture)).not.toThrow();
      expect(JSON.parse(JSON.stringify(fixture.document))).toEqual(
        fixture.document
      );
    }
  });
});

describe("workflow sets — boot variant selection (SAA-1545 §7)", () => {
  it("returns the basic ids for local", async () => {
    const loaded = await loadGraphDemoWorkflows("local");
    expect(loaded.map((document) => document.id).sort()).toEqual(
      basicWorkflowFixtures.map((fixture) => fixture.document.id).sort()
    );
  });

  it("returns the mastra ids for mastra", async () => {
    const loaded = await loadGraphDemoWorkflows("mastra");
    expect(loaded.map((document) => document.id).sort()).toEqual(
      mastraWorkflowFixtures.map((fixture) => fixture.document.id).sort()
    );
  });

  it("returns no synthetic demo set for dagster", async () => {
    await expect(loadGraphDemoWorkflows("dagster")).resolves.toEqual([]);
  });
});
