/**
 * @module as-graph/tests/e2e/graph/fixtures
 * @summary SAA-2049 e2e evidence: the persisted demo workflow fixtures run
 * end to end through the public `GraphExecutionEngine.execute` entrypoint.
 * @description Boots the real engine and drives a representative fixture for
 * every executable kind family — triggers, branching, loops, utilities and the
 * `value`/`result` boundaries — asserting the workflow output.
 */
import { describe, it, expect } from "@jest/globals";
import { runFixtureDocument } from "../../fixtures/workflows/engine";
import {
  executableWorkflowFixtures,
  graphWorkflowFixtures,
} from "../../fixtures/workflows";

describe("demo workflow fixtures — end to end (SAA-2049)", () => {
  it("executes the full executable fixture set through GraphExecutionEngine.execute", async () => {
    for (const fixture of executableWorkflowFixtures) {
      const result = await runFixtureDocument(
        fixture.document,
        fixture.inputs ?? {}
      );
      expect({ id: fixture.id, status: result.status }).toEqual({
        id: fixture.id,
        status: "succeeded",
      });
      for (const [key, value] of Object.entries(
        fixture.expectedOutputs ?? {}
      )) {
        expect({
          id: fixture.id,
          output: key,
          value: (result.outputs as Record<string, unknown>)[key],
        }).toEqual({ id: fixture.id, output: key, value });
      }
    }
  }, 180000);

  it("drives the boundary value/result workflow end to end", async () => {
    const fixture = graphWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-boundary-value"
    )!;
    const result = await runFixtureDocument(fixture.document, fixture.inputs ?? {});
    expect(result.status).toBe("succeeded");
    expect(result.outputs.out).toBeNull();
    expect(result.nodeResults.seed.outputs).toEqual({ value: null });
    expect(result.nodeResults.sink.status).toBe("succeeded");
  });

  it("drives the if→switch workflow down the then/high branch end to end", async () => {
    const fixture = graphWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-if-switch"
    )!;
    const result = await runFixtureDocument(fixture.document, { n: 7 });
    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe(70);
  });
});
