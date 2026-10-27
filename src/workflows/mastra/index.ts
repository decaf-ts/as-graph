/**
 * @module as-graph/workflows/mastra
 * @summary Mastra capability fixture registry (SAA-1545 §5).
 * @description The Mastra fixture set: one focused workflow per Mastra-owned
 * node kind, the focused composite workflows, and the capability coverage
 * matrix. The registry is loaded only by the Mastra boot variant; the local
 * engine seeds `../basic` instead.
 */
import { MASTRA_NODE_CLASSES_BY_KIND } from "../../mastra/nodes/classes";
import { mastraKindFixtures } from "./kind-fixtures";
import { mastraCompositeFixtures } from "./composites";
import { chatAgentFixture } from "./chat-agent.workflow";
import {
  buildMastraCapabilityCoverage,
  MASTRA_CONFORMANCE_SCENARIOS,
  uncoveredMastraCapabilities,
  type MastraCapabilityCoverageRow,
  type MastraConformanceScenario,
} from "./capabilities";
import type { GraphWorkflowFixture } from "../types";

export * from "./kind-fixtures";
export * from "./composites";
export * from "./chat-agent.workflow";
export * from "./capabilities";

/** Stable registry id for the Mastra fixture set. */
export const MASTRA_FIXTURE_REGISTRY_ID = "mastra";

/** Every Mastra-owned node kind the fixture set must target. */
export const ALL_MASTRA_NODE_KINDS: readonly string[] = Object.keys(
  MASTRA_NODE_CLASSES_BY_KIND
).sort((left, right) => left.localeCompare(right));

/**
 * The Mastra capability fixture registry: one focused fixture per Mastra-owned
 * kind, the chat-agent demo, and the focused composites.
 */
export const mastraWorkflowFixtures: GraphWorkflowFixture[] = [
  ...mastraKindFixtures,
  chatAgentFixture,
  ...mastraCompositeFixtures,
];

/** The Mastra fixtures keyed by id. */
export const mastraWorkflowFixturesById: Record<string, GraphWorkflowFixture> =
  Object.fromEntries(
    mastraWorkflowFixtures.map((fixture) => [fixture.id, fixture])
  );

/**
 * Lists Mastra-owned node kinds with no focused fixture target.
 *
 * @returns The uncovered kinds (empty when every kind has a per-kind fixture).
 */
export function uncoveredMastraKindFixtures(): string[] {
  const targets = new Set(
    mastraWorkflowFixtures.flatMap((fixture) => fixture.targetKinds ?? [])
  );
  return ALL_MASTRA_NODE_KINDS.filter((kind) => !targets.has(kind));
}

/** The capability coverage report for the Mastra fixture set. */
export interface MastraFixtureCoverageReport {
  /** Stable registry id. */
  registry: string;
  /** The fixture ids in the set. */
  fixtureIds: string[];
  /** Every Mastra-owned kind the set must target. */
  targetKinds: string[];
  /** Mastra-owned kinds with no focused target. */
  uncoveredKinds: string[];
  /** The full capability matrix (one row per exported capability). */
  capabilities: MastraCapabilityCoverageRow[];
  /** Capability rows with no linked fixture or scenario. */
  uncoveredCapabilities: string[];
  /** The deterministic conformance scenarios. */
  scenarios: readonly MastraConformanceScenario[];
}

/**
 * Builds the deterministic coverage report for the Mastra fixture set.
 *
 * @returns The coverage report.
 */
export function mastraFixtureCoverageReport(): MastraFixtureCoverageReport {
  return {
    registry: MASTRA_FIXTURE_REGISTRY_ID,
    fixtureIds: mastraWorkflowFixtures.map((fixture) => fixture.id).sort(),
    targetKinds: [...ALL_MASTRA_NODE_KINDS],
    uncoveredKinds: uncoveredMastraKindFixtures(),
    capabilities: buildMastraCapabilityCoverage(),
    uncoveredCapabilities: uncoveredMastraCapabilities(),
    scenarios: MASTRA_CONFORMANCE_SCENARIOS,
  };
}

/**
 * Asserts the Mastra fixture set covers every Mastra-owned kind and every
 * `MASTRA_FEATURE_CAPABILITIES` row. Intended for tests and boot-time
 * verification; it does not mutate or build the registry.
 *
 * @throws {Error} when a kind or capability row has no linked evidence. The
 *   message lists the uncovered kinds or capabilities.
 */
export function assertMastraFixtureCoverage(): void {
  const report = mastraFixtureCoverageReport();
  if (report.uncoveredKinds.length > 0) {
    throw new Error(
      `Mastra fixture registry is missing per-kind workflows: ${report.uncoveredKinds.join(", ")}`
    );
  }
  if (report.uncoveredCapabilities.length > 0) {
    throw new Error(
      `Mastra fixture registry is missing capability coverage: ${report.uncoveredCapabilities.join(", ")}`
    );
  }
}
