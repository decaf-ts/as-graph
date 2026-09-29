/**
 * @module as-graph/tests/unit/graph/GraphConditionEvaluator.test
 * @summary Unit tests for the loop condition evaluator.
 */
import { GraphConditionType } from "../../../src/engine/constants";
import { GraphExecutionError } from "../../../src/engine/errors/GraphExecutionError";
import { GraphConditionEvaluator } from "../../../src/engine/loops/GraphConditionEvaluator";

describe("GraphConditionEvaluator", () => {
  const evaluator = new GraphConditionEvaluator();

  it("TRUTHY returns true for truthy values", () => {
    expect(evaluator.evaluate({ type: GraphConditionType.TRUTHY }, 1)).toBe(true);
    expect(evaluator.evaluate({ type: GraphConditionType.TRUTHY }, 0)).toBe(false);
  });

  it("FALSY returns true for falsy values", () => {
    expect(evaluator.evaluate({ type: GraphConditionType.FALSY }, 0)).toBe(true);
    expect(evaluator.evaluate({ type: GraphConditionType.FALSY }, "x")).toBe(false);
  });

  it("EQUALS compares left path to right literal", () => {
    expect(
      evaluator.evaluate({ type: GraphConditionType.EQUALS, right: 5 }, 5)
    ).toBe(true);
    expect(
      evaluator.evaluate({ type: GraphConditionType.EQUALS, right: 5 }, 6)
    ).toBe(false);
  });

  it("NOT_EQUALS", () => {
    expect(
      evaluator.evaluate({ type: GraphConditionType.NOT_EQUALS, right: 5 }, 6)
    ).toBe(true);
  });

  it("GREATER_THAN / GREATER_THAN_OR_EQUAL", () => {
    expect(
      evaluator.evaluate({ type: GraphConditionType.GREATER_THAN, right: 5 }, 6)
    ).toBe(true);
    expect(
      evaluator.evaluate(
        { type: GraphConditionType.GREATER_THAN_OR_EQUAL, right: 5 },
        5
      )
    ).toBe(true);
  });

  it("LESS_THAN / LESS_THAN_OR_EQUAL", () => {
    expect(
      evaluator.evaluate({ type: GraphConditionType.LESS_THAN, right: 5 }, 4)
    ).toBe(true);
    expect(
      evaluator.evaluate(
        { type: GraphConditionType.LESS_THAN_OR_EQUAL, right: 5 },
        5
      )
    ).toBe(true);
  });

  it("EXISTS returns true for defined non-null values", () => {
    expect(evaluator.evaluate({ type: GraphConditionType.EXISTS }, "x")).toBe(true);
    expect(evaluator.evaluate({ type: GraphConditionType.EXISTS }, null)).toBe(false);
    expect(evaluator.evaluate({ type: GraphConditionType.EXISTS }, undefined)).toBe(false);
  });

  it("resolves dotted left paths into nested state", () => {
    expect(
      evaluator.evaluate(
        { type: GraphConditionType.EQUALS, left: "a.b", right: 3 },
        { a: { b: 3 } }
      )
    ).toBe(true);
  });

  it("CUSTOM throws GraphExecutionError", () => {
    expect(() =>
      evaluator.evaluate({ type: GraphConditionType.CUSTOM }, {})
    ).toThrow(GraphExecutionError);
  });

  it("unknown type throws GraphExecutionError", () => {
    expect(() =>
      evaluator.evaluate({ type: "bogus" as any }, {})
    ).toThrow(GraphExecutionError);
  });
});
