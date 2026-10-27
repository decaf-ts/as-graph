/**
 * @module as-graph/workflows/coverage
 * @summary Neutral coverage helpers shared by the basic and Mastra fixture
 * registries (SAA-2049, SAA-1545 §5.2).
 * @description Builds the node → workflow → combo matrix for one registry. The
 * two registries stay separate; this module only provides the shared
 * computation so neither tree duplicates it.
 */
import type { GraphConfigCombo, GraphWorkflowFixture } from "./types";

/** Every config-combination the basic fixture registry must cover. */
export const ALL_CONFIG_COMBOS: GraphConfigCombo[] = [
  "straight-value",
  "code-expression",
  "text-template",
  "exposed-ports",
  "user-controlled-properties",
  "defaults",
];

/**
 * Builds the node → workflow → combo matrix for a fixture list. Every expected
 * kind gets an entry even when it has no fixtures; kinds only referenced by a
 * fixture are added as well.
 *
 * @param fixtures - The fixtures of one registry.
 * @param kinds - The expected node kinds of that registry.
 * @returns The matrix keyed by node kind.
 */
export function buildFixtureMatrix(
  fixtures: readonly GraphWorkflowFixture[],
  kinds: readonly string[] = []
): Record<string, { workflows: string[]; combos: GraphConfigCombo[] }> {
  const matrix: Record<
    string,
    { workflows: string[]; combos: GraphConfigCombo[] }
  > = {};
  for (const kind of kinds) {
    matrix[kind] = { workflows: [], combos: [] };
  }
  for (const fixture of fixtures) {
    for (const kind of fixture.kinds) {
      if (!matrix[kind]) matrix[kind] = { workflows: [], combos: [] };
      if (!matrix[kind].workflows.includes(fixture.id)) {
        matrix[kind].workflows.push(fixture.id);
      }
      for (const combo of fixture.combos) {
        if (!matrix[kind].combos.includes(combo)) {
          matrix[kind].combos.push(combo);
        }
      }
    }
  }
  return matrix;
}

/**
 * Asserts a fixture list covers every expected kind.
 *
 * @param fixtures - The fixtures of one registry.
 * @param kinds - The expected node kinds.
 * @returns The uncovered kinds (empty when complete).
 */
export function uncoveredKinds(
  fixtures: readonly GraphWorkflowFixture[],
  kinds: readonly string[]
): string[] {
  const covered = new Set(fixtures.flatMap((fixture) => fixture.kinds));
  return kinds.filter((kind) => !covered.has(kind));
}

/**
 * Normalises a fixture's shared metadata so every registry entry records its
 * family, primary engine, target kinds, capabilities, host services, and
 * engine-aware expectation. Values stay JSON-safe.
 *
 * For `basic` fixtures the legacy `executable`/`skipReason`/`expectedOutputs`
 * fields are also lifted into a `local` expectation. A fixture that already
 * declares `expectations` is left untouched.
 *
 * @param fixture - The fixture to normalise.
 * @param family - The tree/registry that owns the fixture.
 * @param engine - The primary engine of that tree.
 * @returns The normalised fixture.
 * @example
 * ```ts
 * const fixture = normalizeFixture(
 *   {
 *     id: "fixture-manual-log",
 *     document,
 *     kinds: ["core.trigger.manual"],
 *     combos: ["defaults"],
 *     executable: true,
 *   },
 *   "basic",
 *   "local"
 * );
 * console.log(fixture.family); // "basic"
 * console.log(fixture.expectations?.local?.executable); // true
 * ```
 */
export function normalizeFixture(
  fixture: GraphWorkflowFixture,
  family: "basic" | "mastra",
  engine: "local" | "mastra"
): GraphWorkflowFixture {
  const targetKinds = fixture.targetKinds ?? fixture.kinds;
  return {
    ...fixture,
    family: fixture.family ?? family,
    engine: fixture.engine ?? engine,
    targetKinds,
    capabilities: fixture.capabilities ?? [],
    requiredHostServices: fixture.requiredHostServices ?? [],
    expectations:
      fixture.expectations ??
      (family === "basic"
        ? {
            local: {
              executable: fixture.executable,
              ...(fixture.skipReason ? { skipReason: fixture.skipReason } : {}),
              ...(fixture.expectedOutputs
                ? { expectedOutputs: fixture.expectedOutputs }
                : {}),
            },
          }
        : undefined),
  };
}
