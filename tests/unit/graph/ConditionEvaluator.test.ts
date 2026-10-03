/**
 * @module as-graph/tests/unit/graph/ConditionEvaluator.test
 * @summary Unit tests for the shared flow-control condition dispatcher
 * (DECAF-32 §22.3–22.4, SAA-66).
 * @description Covers `isCodeCondition`, `isConditionExpression`,
 * `evaluateConditionSync`, `evaluateCodeCondition`, `evaluateCondition`, and the
 * `GraphConditionEvaluator.evaluateAsync` code path — including the
 * `GRAPH_CODE_SANDBOX_NOT_CONFIGURED` and `GRAPH_UNKNOWN_CONDITION_TYPE`
 * failure modes.
 */
import {
  evaluateCodeCondition,
  evaluateCondition,
  evaluateConditionSync,
  isCodeCondition,
  isConditionExpression,
} from "../../../src/engine/loops/ConditionEvaluator";
import { GraphConditionEvaluator } from "../../../src/engine/loops/GraphConditionEvaluator";
import { GraphExecutionError } from "../../../src/engine/errors/GraphExecutionError";
import type {
  CodeSandboxContext,
  CodeSandboxEvaluator,
} from "../../../src/engine/execution/CodeSandboxEvaluator";
import type { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import type {
  CodeCondition,
  ConditionExpression,
} from "../../../src/shared/graph";
import { buildNodeContext } from "./nodes/node-test-utils";

const CODE_CONDITION: CodeCondition = {
  type: "code",
  code: "return true;",
};

const EXPRESSION: ConditionExpression = {
  op: "eq",
  left: { path: "n" },
  right: { const: 1 },
};

/** Engine facade exposing only the `codeSandboxEvaluator` the dispatcher reads. */
function engineWith(
  codeSandboxEvaluator?: CodeSandboxEvaluator
): GraphExecutionEngine {
  return { codeSandboxEvaluator } as unknown as GraphExecutionEngine;
}

/** Captures every `evaluate` call so tests can assert the forwarded context. */
function recordingEvaluator(
  result: unknown
): CodeSandboxEvaluator & { calls: CodeSandboxContext[] } {
  const calls: CodeSandboxContext[] = [];
  return {
    calls,
    evaluate: (ctx) => {
      calls.push(ctx);
      return result;
    },
  };
}

describe("ConditionEvaluator", () => {
  describe("isCodeCondition", () => {
    it("detects a code condition by its type field", () => {
      expect(isCodeCondition(CODE_CONDITION)).toBe(true);
      expect(isCodeCondition({ type: "code", code: "return 1;", language: "javascript" })).toBe(
        true
      );
    });

    it("rejects graphical expressions, other shapes, and non-objects", () => {
      expect(isCodeCondition(EXPRESSION)).toBe(false);
      expect(isCodeCondition({ type: "other" })).toBe(false);
      expect(isCodeCondition(null)).toBe(false);
      expect(isCodeCondition("code")).toBe(false);
      expect(isCodeCondition(undefined)).toBe(false);
    });
  });

  describe("isConditionExpression", () => {
    it("detects a graphical expression by its string op field", () => {
      expect(isConditionExpression(EXPRESSION)).toBe(true);
      expect(isConditionExpression({ op: "exists", value: { path: "a" } })).toBe(true);
    });

    it("rejects code conditions, non-string ops, and non-objects", () => {
      expect(isConditionExpression(CODE_CONDITION)).toBe(false);
      expect(isConditionExpression({ op: 5 })).toBe(false);
      expect(isConditionExpression(null)).toBe(false);
      expect(isConditionExpression("eq")).toBe(false);
    });
  });

  describe("evaluateConditionSync", () => {
    it("evaluates a graphical ConditionExpression", () => {
      expect(evaluateConditionSync(EXPRESSION, { n: 1 })).toBe(true);
      expect(evaluateConditionSync(EXPRESSION, { n: 2 })).toBe(false);
    });

    it("throws GRAPH_UNKNOWN_CONDITION_TYPE for a code condition", () => {
      let error: unknown;
      try {
        evaluateConditionSync(CODE_CONDITION, {});
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GraphExecutionError);
      expect((error as GraphExecutionError).graphCode).toBe(
        "GRAPH_UNKNOWN_CONDITION_TYPE"
      );
    });

    it("includes the carrier label in the unknown-condition message", () => {
      expect(() => evaluateConditionSync({ bogus: true }, {}, "if")).toThrow(
        /Unknown if condition type/i
      );
      expect(() => evaluateConditionSync({ bogus: true }, {})).toThrow(
        /Unknown flow condition type/i
      );
    });
  });

  describe("evaluateCodeCondition", () => {
    it("dispatches the code condition to the registered evaluator", async () => {
      const evaluator = recordingEvaluator(true);
      const context = buildNodeContext("core.flow.if", {
        engine: engineWith(evaluator),
      });
      await expect(
        evaluateCodeCondition(CODE_CONDITION, { n: 1 }, context)
      ).resolves.toBe(true);
      expect(evaluator.calls[0].code).toBe("return true;");
      expect(evaluator.calls[0].language).toBeUndefined();
    });

    it("coerces truthy and falsy sandbox results to a boolean", async () => {
      const truthy = buildNodeContext("core.flow.if", {
        engine: engineWith(recordingEvaluator("non-empty")),
      });
      const falsy = buildNodeContext("core.flow.if", {
        engine: engineWith(recordingEvaluator(0)),
      });
      await expect(
        evaluateCodeCondition(CODE_CONDITION, {}, truthy)
      ).resolves.toBe(true);
      await expect(
        evaluateCodeCondition(CODE_CONDITION, {}, falsy)
      ).resolves.toBe(false);
    });

    it("exposes the input map as $input and forwards vars/item/index/nodes", async () => {
      const evaluator = recordingEvaluator(false);
      const context = buildNodeContext("core.flow.if", {
        engine: engineWith(evaluator),
        contextMetadata: {
          vars: { mode: "test" },
          item: { id: 7 },
          index: 3,
          nodes: { upstream: { result: 42 } },
        },
      });
      await evaluateCodeCondition(CODE_CONDITION, { n: 5 }, context);
      expect(evaluator.calls[0].input).toEqual({ n: 5 });
      expect(evaluator.calls[0].vars).toEqual({ mode: "test" });
      expect(evaluator.calls[0].item).toEqual({ id: 7 });
      expect(evaluator.calls[0].index).toBe(3);
      expect(evaluator.calls[0].nodes).toEqual({ upstream: { result: 42 } });
    });

    it("throws GRAPH_CODE_SANDBOX_NOT_CONFIGURED when no evaluator is registered", async () => {
      const context = buildNodeContext("core.flow.if");
      let error: unknown;
      try {
        await evaluateCodeCondition(CODE_CONDITION, {}, context);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GraphExecutionError);
      expect((error as GraphExecutionError).graphCode).toBe(
        "GRAPH_CODE_SANDBOX_NOT_CONFIGURED"
      );
      await expect(
        evaluateCodeCondition(CODE_CONDITION, {}, context)
      ).rejects.toThrow(/CodeSandboxEvaluator.*registered/i);
    });
  });

  describe("evaluateCondition", () => {
    it("dispatches code conditions to the sandbox evaluator", async () => {
      const evaluator = recordingEvaluator(true);
      const context = buildNodeContext("core.flow.if", {
        engine: engineWith(evaluator),
      });
      await expect(
        evaluateCondition(CODE_CONDITION, { input: { n: 1 }, state: {} }, context)
      ).resolves.toBe(true);
      expect(evaluator.calls).toHaveLength(1);
    });

    it("evaluates graphical expressions synchronously against the state", async () => {
      const context = buildNodeContext("core.flow.if");
      await expect(
        evaluateCondition(EXPRESSION, { input: {}, state: { n: 1 } }, context)
      ).resolves.toBe(true);
      await expect(
        evaluateCondition(EXPRESSION, { input: {}, state: { n: 2 } }, context)
      ).resolves.toBe(false);
    });

    it("throws GRAPH_UNKNOWN_CONDITION_TYPE for an unknown shape", async () => {
      const context = buildNodeContext("core.flow.if");
      await expect(
        evaluateCondition({ bogus: true } as never, { input: {}, state: {} }, context)
      ).rejects.toMatchObject({ graphCode: "GRAPH_UNKNOWN_CONDITION_TYPE" });
    });
  });

  describe("GraphConditionEvaluator.evaluateAsync", () => {
    const evaluator = new GraphConditionEvaluator();

    it("evaluates a code condition through the sandbox", async () => {
      const sandbox = recordingEvaluator(true);
      const context = buildNodeContext("core.loop.while", {
        engine: engineWith(sandbox),
      });
      await expect(
        evaluator.evaluateAsync(CODE_CONDITION, { n: 1 }, context, { n: 1 })
      ).resolves.toBe(true);
      expect(sandbox.calls[0].input).toEqual({ n: 1 });
    });

    it("delegates graphical and built-in conditions synchronously", async () => {
      const context = buildNodeContext("core.loop.while");
      await expect(
        evaluator.evaluateAsync(EXPRESSION, { n: 1 }, context, {})
      ).resolves.toBe(true);
      await expect(
        evaluator.evaluateAsync(
          { type: "lessThan", left: "n", right: 2 } as never,
          { n: 1 },
          context,
          {}
        )
      ).resolves.toBe(true);
    });

    it("throws GRAPH_CODE_SANDBOX_NOT_CONFIGURED for a code condition without an evaluator", async () => {
      const context = buildNodeContext("core.loop.while");
      await expect(
        evaluator.evaluateAsync(CODE_CONDITION, {}, context, {})
      ).rejects.toMatchObject({
        graphCode: "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
      });
    });

    it("throws GRAPH_UNKNOWN_CONDITION_TYPE for an unknown shape", async () => {
      const context = buildNodeContext("core.loop.while");
      await expect(
        evaluator.evaluateAsync({ bogus: true } as never, {}, context, {})
      ).rejects.toMatchObject({ graphCode: "GRAPH_UNKNOWN_CONDITION_TYPE" });
    });
  });
});
