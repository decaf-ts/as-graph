/**
 * @module as-graph/tests/integration/graph/engine-fixtures
 * @summary SAA-2052 evidence: the persisted demo workflow fixture set runs
 * through the real built-in node catalogue + isolated-vm sandbox evaluator,
 * asserting the workflow output and per-node intermediate inputs/outputs.
 * @description Every fixture is executable under the new execution contracts:
 * `GraphValueTemplate` parameters resolve at execution time, the error boundary
 * catches its failing `try` body, human approval emits a single branch, while/until
 * honor distinct body ports, and `GraphBreakSignal` stops its enclosing foreach.
 */
import { describe, it, expect } from "@jest/globals";
import { runFixtureDocument } from "../../fixtures/workflows/engine";
import {
  executableWorkflowFixtures,
  graphWorkflowFixtures,
  type GraphWorkflowFixture,
} from "../../fixtures/workflows";

function expectedSubset(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
}

describe("demo workflow fixtures — engine execution (SAA-2052)", () => {
  it.each(executableWorkflowFixtures.map((fixture) => [fixture.id, fixture]))(
    "executes %s and asserts the workflow output",
    async (_id, fixture: GraphWorkflowFixture) => {
      const result = await runFixtureDocument(
        fixture.document,
        fixture.inputs ?? {}
      );
      expect(result.status).toBe("succeeded");
      expectedSubset(
        result.outputs as Record<string, unknown>,
        fixture.expectedOutputs ?? {}
      );
    },
    120000
  );

  it("records per-node intermediate inputs/outputs for the manual→log workflow", async () => {
    const fixture = executableWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-manual-log"
    )!;
    const result = await runFixtureDocument(fixture.document, fixture.inputs ?? {});
    expect(result.nodeResults.trigger.outputs).toEqual({ payload: null });
    expect(result.nodeResults.logger.inputs).toEqual({ value: null });
    expect(result.nodeResults.logger.outputs).toEqual({ value: null });
    expect(result.nodeResults.audit.inputs).toEqual({ value: null });
  });

  it("records per-node intermediate inputs/outputs for the if→switch workflow", async () => {
    const fixture = executableWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-if-switch"
    )!;
    const result = await runFixtureDocument(fixture.document, fixture.inputs ?? {});
    expect(result.nodeResults.branch.inputs).toEqual({ value: 7 });
    expect(result.nodeResults.branch.outputs).toEqual({ then: 7 });
    expect(result.nodeResults.big.inputs).toEqual({
      data: 7,
      code: "return $input.data * 10;",
    });
    expect(result.nodeResults.big.outputs).toEqual({ result: 70 });
    expect(result.nodeResults.route.inputs).toEqual({ value: 70 });
    expect(result.nodeResults.route.outputs).toEqual({ high: 70 });
    expect(result.nodeResults.low.status).toBe("skipped");
  });

  it("catches the failing error-boundary try body and emits `error`", async () => {
    const fixture = graphWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-error-boundary"
    )!;
    const result = await runFixtureDocument(fixture.document, fixture.inputs ?? {});
    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBeUndefined();
    expect(result.outputs.caught).toBeDefined();
    expect(String(result.outputs.caught)).toMatch(/boom/i);
    expect(result.nodeResults.guard.outputs).toHaveProperty("error");
    expect(result.nodeResults.guard.outputs).not.toHaveProperty("result");
  });

  it("emits only the `approved` branch for the human approval gate", async () => {
    const fixture = graphWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-human-approval"
    )!;
    const result = await runFixtureDocument(fixture.document, fixture.inputs ?? {});
    expect(result.status).toBe("succeeded");
    expect(result.outputs.approved).toBe("ticket-42");
    expect(result.outputs.rejected).toBeUndefined();
    expect(result.nodeResults.approval.outputs).toEqual({
      approved: "ticket-42",
    });
  });

  it("stops the enclosing foreach when the break token propagates", async () => {
    const fixture = executableWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-foreach-break"
    )!;
    const result = await runFixtureDocument(fixture.document, fixture.inputs ?? {});
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.loop.outputs.broken).toBe(true);
    expect(result.nodeResults.loop.outputs.iterations).toBe(1);
    expect(result.outputs.collected).toEqual([2]);
  });

  it("runs while/until loops over distinct body seed/result ports", async () => {
    const fixture = graphWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-loops-while-until"
    )!;
    const result = await runFixtureDocument(fixture.document, fixture.inputs ?? {});
    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toEqual({ n: 4 });
    expect(result.nodeResults.whileLoop.outputs.iterations).toBe(3);
    expect(result.nodeResults.untilLoop.outputs.iterations).toBe(1);
  });

  it("resolves GraphValueTemplate user properties at execution time", async () => {
    const fixture = graphWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-value-templates"
    )!;
    const result = await runFixtureDocument(fixture.document, fixture.inputs ?? {});
    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe("warn");
    expect(result.nodeResults.expressionLog.status).toBe("succeeded");
    expect(result.nodeResults.templateLog.status).toBe("succeeded");
  });
});
