/**
 * @module as-graph/workflows/types
 * @summary Neutral types for the persisted demo workflow fixture registries
 * (SAA-2049, SAA-1545 §5).
 * @description The fixture trees share these neutral, JSON-safe types only.
 * Each registry (`basic/` and `mastra/`) owns its own fixture array so the two
 * sets stay independently addressable and boot loads exactly one variant.
 */
import type { GraphWorkflowDocument } from "../shared/graph";
import type { GraphExecutionValues } from "../engine/types";

/**
 * The six node-configuration combinations the fixture set must cover
 * (SAA-2049 §2).
 */
export type GraphConfigCombo =
  | "straight-value"
  | "code-expression"
  | "text-template"
  | "exposed-ports"
  | "user-controlled-properties"
  | "defaults";

/** The engine a fixture expectation applies to. */
export type GraphFixtureEngine = "local" | "mastra" | "dagster";

/** The fixture tree/registry a fixture belongs to. */
export type GraphFixtureFamily = "basic" | "mastra";

/** Terminal status a fixture is expected to reach on an engine. */
export type GraphFixtureExpectedStatus =
  | "succeeded"
  | "failed"
  | "suspended";

/**
 * Engine-aware expectation for one fixture (SAA-1545 §5.2). A fixture may be
 * runnable on one engine while intentionally unsupported on another; the
 * expectation is recorded per engine instead of as one global flag.
 */
export interface GraphFixtureEngineExpectation {
  /** Whether the fixture can be executed on this engine at all. */
  executable: boolean;
  /** Why the fixture is intentionally unsupported on this engine. */
  skipReason?: string;
  /** Expected terminal status of an execution attempt. */
  expectedStatus?: GraphFixtureExpectedStatus;
  /** Expected stable graph error code for a fail-closed expectation. */
  expectedGraphCode?: string;
  /** Partial expected workflow outputs. */
  expectedOutputs?: Record<string, unknown>;
  /** Expected graph execution event types, in order-agnostic membership form. */
  expectedEvents?: string[];
  /** Node ids expected to report `succeeded` in the run. */
  expectedSucceededNodeIds?: string[];
  /** Node ids expected to report `skipped` in the run. */
  expectedSkippedNodeIds?: string[];
}

/**
 * A persisted demo workflow fixture and its execution expectations.
 */
export interface GraphWorkflowFixture {
  /** Stable fixture/workflow id. */
  id: string;
  /** The canonical persisted document. */
  document: GraphWorkflowDocument;
  /** Built-in node kinds the workflow exercises. */
  kinds: string[];
  /** Node kinds the fixture is explicitly written to exercise. */
  targetKinds?: string[];
  /** Config combos the workflow exercises. */
  combos: GraphConfigCombo[];
  /** The fixture tree/registry that owns the fixture. */
  family?: GraphFixtureFamily;
  /** The primary engine the fixture targets. */
  engine?: GraphFixtureEngine;
  /** `MASTRA_FEATURE_CAPABILITIES` rows this fixture demonstrates. */
  capabilities?: string[];
  /**
   * Host-service keys the fixture needs (for example `createAgent`,
   * `embedText`, `resolveVoice`). The default suite injects deterministic
   * fakes for all of them; the metadata stays JSON-safe.
   */
  requiredHostServices?: string[];
  /** Deterministic conformance scenario id for capabilities without a node. */
  scenario?: string;
  /** Engine-aware expectations, keyed by engine. */
  expectations?: Partial<
    Record<GraphFixtureEngine, GraphFixtureEngineExpectation>
  >;
  /**
   * Legacy single-engine executable flag. New fixtures should set
   * {@link expectations} instead; the registry normalises this into the local
   * expectation for basic fixtures.
   */
  executable: boolean;
  /** Why a non-executable fixture cannot run (production gap). */
  skipReason?: string;
  /** Inputs passed to `GraphExecutionEngine.execute`. */
  inputs?: GraphExecutionValues;
  /** Partial expected workflow outputs. */
  expectedOutputs?: Record<string, unknown>;
}

/**
 * Reads the expectation for one engine, falling back to the legacy
 * `executable`/`skipReason` fields when the fixture does not declare per-engine
 * expectations.
 *
 * @param fixture - The fixture to read.
 * @param engine - The target engine.
 * @returns The resolved expectation.
 */
export function fixtureExpectationOn(
  fixture: GraphWorkflowFixture,
  engine: GraphFixtureEngine
): GraphFixtureEngineExpectation {
  const declared = fixture.expectations?.[engine];
  if (declared) return declared;
  return {
    executable: fixture.executable,
    ...(fixture.skipReason ? { skipReason: fixture.skipReason } : {}),
  };
}

/**
 * Reports whether a fixture is executable on one engine, resolving per-engine
 * expectations before the legacy `executable` flag.
 *
 * @param fixture - The fixture to check.
 * @param engine - The target engine.
 * @returns `true` when the fixture is executable there.
 * @example
 * ```ts
 * fixtureExecutableOn(mastraFixture, "mastra"); // true
 * fixtureExecutableOn(mastraFixture, "local"); // false
 * ```
 */
export function fixtureExecutableOn(
  fixture: GraphWorkflowFixture,
  engine: GraphFixtureEngine
): boolean {
  return fixtureExpectationOn(fixture, engine).executable;
}
