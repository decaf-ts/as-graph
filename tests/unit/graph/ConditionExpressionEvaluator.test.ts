/**
 * @module as-graph/tests/unit/graph/ConditionExpressionEvaluator.test
 * @summary Unit tests for the ConditionExpression DSL evaluator (DECAF-32 §22.3).
 */
import { ConditionExpressionEvaluator } from "../../../src/engine/loops/ConditionExpressionEvaluator";
import { GraphConditionEvaluator } from "../../../src/engine/loops/GraphConditionEvaluator";
import { GraphExecutionError } from "../../../src/engine/errors/GraphExecutionError";
import type { ConditionExpression } from "../../../src/shared/graph";

describe("ConditionExpressionEvaluator", () => {
  const evaluator = new ConditionExpressionEvaluator();

  describe("comparison operators", () => {
    it("eq returns true when left equals right", () => {
      const expr: ConditionExpression = { op: "eq", left: { const: 5 }, right: { const: 5 } };
      expect(evaluator.evaluate(expr, {})).toBe(true);
    });

    it("eq returns false when left differs from right", () => {
      const expr: ConditionExpression = { op: "eq", left: { const: 5 }, right: { const: 6 } };
      expect(evaluator.evaluate(expr, {})).toBe(false);
    });

    it("neq returns true when values differ", () => {
      const expr: ConditionExpression = { op: "neq", left: { const: "a" }, right: { const: "b" } };
      expect(evaluator.evaluate(expr, {})).toBe(true);
    });

    it("gt / gte", () => {
      expect(evaluator.evaluate({ op: "gt", left: { const: 10 }, right: { const: 5 } }, {})).toBe(true);
      expect(evaluator.evaluate({ op: "gt", left: { const: 5 }, right: { const: 5 } }, {})).toBe(false);
      expect(evaluator.evaluate({ op: "gte", left: { const: 5 }, right: { const: 5 } }, {})).toBe(true);
    });

    it("lt / lte", () => {
      expect(evaluator.evaluate({ op: "lt", left: { const: 3 }, right: { const: 5 } }, {})).toBe(true);
      expect(evaluator.evaluate({ op: "lt", left: { const: 5 }, right: { const: 5 } }, {})).toBe(false);
      expect(evaluator.evaluate({ op: "lte", left: { const: 5 }, right: { const: 5 } }, {})).toBe(true);
    });
  });

  describe("logical operators", () => {
    it("and returns true when all conditions are true", () => {
      const expr: ConditionExpression = {
        op: "and",
        conditions: [
          { op: "eq", left: { const: 1 }, right: { const: 1 } },
          { op: "eq", left: { const: 2 }, right: { const: 2 } },
        ],
      };
      expect(evaluator.evaluate(expr, {})).toBe(true);
    });

    it("and returns false when any condition is false", () => {
      const expr: ConditionExpression = {
        op: "and",
        conditions: [
          { op: "eq", left: { const: 1 }, right: { const: 1 } },
          { op: "eq", left: { const: 2 }, right: { const: 3 } },
        ],
      };
      expect(evaluator.evaluate(expr, {})).toBe(false);
    });

    it("or returns true when any condition is true", () => {
      const expr: ConditionExpression = {
        op: "or",
        conditions: [
          { op: "eq", left: { const: 1 }, right: { const: 2 } },
          { op: "eq", left: { const: 3 }, right: { const: 3 } },
        ],
      };
      expect(evaluator.evaluate(expr, {})).toBe(true);
    });

    it("or returns false when all conditions are false", () => {
      const expr: ConditionExpression = {
        op: "or",
        conditions: [
          { op: "eq", left: { const: 1 }, right: { const: 2 } },
          { op: "eq", left: { const: 3 }, right: { const: 4 } },
        ],
      };
      expect(evaluator.evaluate(expr, {})).toBe(false);
    });

    it("not negates a condition", () => {
      const expr: ConditionExpression = {
        op: "not",
        condition: { op: "eq", left: { const: 1 }, right: { const: 2 } },
      };
      expect(evaluator.evaluate(expr, {})).toBe(true);
    });

    it("nested and/or/not combinations", () => {
      const expr: ConditionExpression = {
        op: "or",
        conditions: [
          { op: "and", conditions: [
            { op: "eq", left: { const: 1 }, right: { const: 1 } },
            { op: "not", condition: { op: "eq", left: { const: 2 }, right: { const: 3 } } },
          ] },
          { op: "eq", left: { const: 0 }, right: { const: 1 } },
        ],
      };
      expect(evaluator.evaluate(expr, {})).toBe(true);
    });
  });

  describe("exists operator", () => {
    it("returns true for a defined non-null value", () => {
      const expr: ConditionExpression = { op: "exists", value: { const: "x" } };
      expect(evaluator.evaluate(expr, {})).toBe(true);
    });

    it("returns false for null", () => {
      const expr: ConditionExpression = { op: "exists", value: { const: null } };
      expect(evaluator.evaluate(expr, {})).toBe(false);
    });

    it("returns false for undefined", () => {
      const expr: ConditionExpression = { op: "exists", value: { const: undefined } };
      expect(evaluator.evaluate(expr, {})).toBe(false);
    });
  });

  describe("ExprValue resolution", () => {
    it("{const} resolves to the literal value", () => {
      const expr: ConditionExpression = { op: "eq", left: { const: "hello" }, right: { const: "hello" } };
      expect(evaluator.evaluate(expr, {})).toBe(true);
    });

    it("{path} resolves a dotted path into state", () => {
      const expr: ConditionExpression = {
        op: "eq",
        left: { path: "user.age" },
        right: { const: 30 },
      };
      expect(evaluator.evaluate(expr, { user: { age: 30 } })).toBe(true);
    });

    it("{path} returns undefined for missing paths", () => {
      const expr: ConditionExpression = {
        op: "exists",
        value: { path: "missing.key" },
      };
      expect(evaluator.evaluate(expr, { other: 1 })).toBe(false);
    });

    it("{step, path} resolves from a nodes map when present", () => {
      const expr: ConditionExpression = {
        op: "eq",
        left: { step: "nodeA", path: "output" },
        right: { const: 42 },
      };
      const state = { nodes: { nodeA: { output: 42 } } };
      expect(evaluator.evaluate(expr, state)).toBe(true);
    });

    it("{step, path} falls back to state lookup when nodes map is absent", () => {
      const expr: ConditionExpression = {
        op: "eq",
        left: { step: "nodeA", path: "value" },
        right: { const: 7 },
      };
      expect(evaluator.evaluate(expr, { value: 7 })).toBe(true);
    });
  });

  describe("unknown op", () => {
    it("throws GraphExecutionError", () => {
      const expr = { op: "bogus", left: { const: 1 }, right: { const: 1 } } as unknown as ConditionExpression;
      expect(() => evaluator.evaluate(expr, {})).toThrow(GraphExecutionError);
    });
  });
});

describe("GraphConditionEvaluator (ConditionExpression dispatch)", () => {
  const evaluator = new GraphConditionEvaluator();

  it("dispatches to ConditionExpressionEvaluator when `op` is present", () => {
    const condition = { op: "eq", left: { const: 1 }, right: { const: 1 } } as never;
    expect(evaluator.evaluate(condition, {})).toBe(true);
  });

  it("falls back to built-in `type`-based evaluation when `op` is absent", () => {
    expect(evaluator.evaluate({ type: "truthy" }, 1)).toBe(true);
  });

  it("ConditionExpression `lt` works through GraphConditionEvaluator", () => {
    const condition = { op: "lt", left: { path: "count" }, right: { const: 5 } } as never;
    expect(evaluator.evaluate(condition, { count: 3 })).toBe(true);
    expect(evaluator.evaluate(condition, { count: 10 })).toBe(false);
  });
});
