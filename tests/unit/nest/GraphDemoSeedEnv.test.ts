/**
 * @module as-graph/tests/unit/nest/GraphDemoSeedEnv.test
 * @summary SAA-804 (from SAA-798) F5 verification: `graphDemoSeedEnabledFromEnv`
 * gates boot-time demo-workflow seeding from the `GRAPH_SEED_DEMO` env var.
 * @description Behavioural checks over the pure resolver:
 * - enabled by default when the var is unset or empty/blank (existing hosts
 *   unaffected; a source checkout keeps its fixtures);
 * - disabled (case-insensitive, whitespace tolerant) for `off`/`false`/`0`/`no`/
 *   `disabled`;
 * - enabled for any other value (`on`/`true`/`1`/arbitrary).
 */
import { describe, it, expect } from "@jest/globals";

import {
  graphDemoSeedEnabledFromEnv,
  loadGraphDemoWorkflows,
  GRAPH_SEED_DEMO_ENV,
} from "../../../src/nest/graph/GraphBackendHost";

/** Builds a minimal env bag holding only the seed flag. */
function env(value: string | undefined): NodeJS.ProcessEnv {
  return (
    value === undefined ? {} : { [GRAPH_SEED_DEMO_ENV]: value }
  ) as NodeJS.ProcessEnv;
}

/**
 * Mirrors the exact boot-time composition in `main.ts`:
 * `graphDemoSeedEnabledFromEnv(env) ? loadGraphDemoWorkflows() : []`.
 */
async function composedDemoWorkflows(
  value: string | undefined
): Promise<readonly { id: string }[]> {
  const bag = env(value);
  return graphDemoSeedEnabledFromEnv(bag)
    ? await loadGraphDemoWorkflows()
    : [];
}

describe("graphDemoSeedEnabledFromEnv (SAA-798 F5)", () => {
  it("names the env var GRAPH_SEED_DEMO", () => {
    expect(GRAPH_SEED_DEMO_ENV).toBe("GRAPH_SEED_DEMO");
  });

  it("enabled by default when the var is unset or empty/blank", () => {
    expect(graphDemoSeedEnabledFromEnv(env(undefined))).toBe(true);
    expect(graphDemoSeedEnabledFromEnv(env(""))).toBe(true);
    expect(graphDemoSeedEnabledFromEnv(env("   "))).toBe(true);
  });

  it.each([["off"], ["OFF"], [" off "], ["false"], ["0"], ["no"], ["disabled"]])(
    "disabled for '%s' (case-insensitive, trimmed)",
    (value) => {
      expect(graphDemoSeedEnabledFromEnv(env(value))).toBe(false);
    }
  );

  it.each([["on"], ["ON"], ["true"], ["1"], ["yes"], ["enabled"], ["anything"]])(
    "enabled for other value '%s'",
    (value) => {
      expect(graphDemoSeedEnabledFromEnv(env(value))).toBe(true);
    }
  );

  it("gates a real, non-empty fixture set: default seeds, 'off' seeds nothing", async () => {
    // The default composition resolves the fixture registry (non-empty), so an
    // empty 'off' composition proves the flag actually suppresses seeding rather
    // than observing an already-empty registry.
    const seeded = await composedDemoWorkflows(undefined);
    expect(seeded.length).toBeGreaterThan(0);

    const suppressed = await composedDemoWorkflows("off");
    expect(suppressed).toEqual([]);
  });
});
