/**
 * @module as-graph/tests/unit/graph/mastra/MastraConditionBridge
 * @summary Driver tests for `MastraConditionBridge` (SAA-201 case 3).
 * @description Proves the gap-6 truth-table parity invariant: the Mastra branch
 * predicate returns exactly what the reference `evaluateConditionSync` returns for
 * the same condition and state, and that code-mode conditions fail closed.
 */
import {
  assertMastraConditionSupported,
  mastraConditionPredicate,
} from "../../../../src/mastra/MastraConditionBridge";
import { evaluateConditionSync } from "../../../../src/engine/loops/ConditionEvaluator";
import { GRAPH_MASTRA_UNSUPPORTED_KIND } from "../../../../src/mastra/types";
import type { Condition, ConditionExpression } from "../../../../src/shared/graph";
import { graphCodeOf } from "./helpers";

interface TruthCase {
  name: string;
  condition: ConditionExpression;
  state: unknown;
}

const TRUTH_TABLE: TruthCase[] = [
  {
    name: "eq const match",
    condition: { op: "eq", left: { path: "value" }, right: { const: 5 } },
    state: { value: 5 },
  },
  {
    name: "eq const miss",
    condition: { op: "eq", left: { path: "value" }, right: { const: 5 } },
    state: { value: 6 },
  },
  {
    name: "neq",
    condition: { op: "neq", left: { path: "value" }, right: { const: 5 } },
    state: { value: 6 },
  },
  {
    name: "gt true",
    condition: { op: "gt", left: { path: "value" }, right: { const: 5 } },
    state: { value: 7 },
  },
  {
    name: "gt false",
    condition: { op: "gt", left: { path: "value" }, right: { const: 5 } },
    state: { value: 5 },
  },
  {
    name: "gte boundary",
    condition: { op: "gte", left: { path: "value" }, right: { const: 5 } },
    state: { value: 5 },
  },
  {
    name: "lt",
    condition: { op: "lt", left: { path: "value" }, right: { const: 5 } },
    state: { value: 4 },
  },
  {
    name: "lte",
    condition: { op: "lte", left: { path: "value" }, right: { const: 5 } },
    state: { value: 5 },
  },
  {
    name: "nested path",
    condition: {
      op: "eq",
      left: { path: "payload.status" },
      right: { const: "open" },
    },
    state: { payload: { status: "open" } },
  },
  {
    name: "step reference",
    condition: {
      op: "eq",
      left: { step: "first", path: "result" },
      right: { const: 42 },
    },
    state: { nodes: { first: { result: 42 } } },
  },
  {
    name: "and true",
    condition: {
      op: "and",
      conditions: [
        { op: "gt", left: { path: "value" }, right: { const: 1 } },
        { op: "lt", left: { path: "value" }, right: { const: 10 } },
      ],
    },
    state: { value: 5 },
  },
  {
    name: "and false",
    condition: {
      op: "and",
      conditions: [
        { op: "gt", left: { path: "value" }, right: { const: 1 } },
        { op: "lt", left: { path: "value" }, right: { const: 3 } },
      ],
    },
    state: { value: 5 },
  },
  {
    name: "or true",
    condition: {
      op: "or",
      conditions: [
        { op: "eq", left: { path: "value" }, right: { const: 1 } },
        { op: "eq", left: { path: "value" }, right: { const: 5 } },
      ],
    },
    state: { value: 5 },
  },
  {
    name: "or false",
    condition: {
      op: "or",
      conditions: [
        { op: "eq", left: { path: "value" }, right: { const: 1 } },
        { op: "eq", left: { path: "value" }, right: { const: 2 } },
      ],
    },
    state: { value: 5 },
  },
  {
    name: "not",
    condition: {
      op: "not",
      condition: { op: "eq", left: { path: "value" }, right: { const: 5 } },
    },
    state: { value: 5 },
  },
  {
    name: "exists present",
    condition: { op: "exists", value: { path: "value" } },
    state: { value: 0 },
  },
  {
    name: "exists absent",
    condition: { op: "exists", value: { path: "missing" } },
    state: {},
  },
  {
    name: "exists null",
    condition: { op: "exists", value: { path: "value" } },
    state: { value: null },
  },
];

describe("MastraConditionBridge", () => {
  it.each(TRUTH_TABLE)(
    "matches evaluateConditionSync for $name",
    ({ condition, state }) => {
      const reference = evaluateConditionSync(condition, state, "if");
      const predicate = mastraConditionPredicate(condition, "if");

      expect(predicate({ state })).toBe(reference);
    }
  );

  it("evaluates against inputData when supplied, mirroring evaluateConditionSync", () => {
    const condition: ConditionExpression = {
      op: "eq",
      left: { path: "value" },
      right: { const: 5 },
    };
    const predicate = mastraConditionPredicate(condition, "if");

    expect(predicate({ inputData: { value: 5 }, state: { value: 1 } })).toBe(true);
    expect(predicate({ inputData: { value: 5 }, state: { value: 1 } })).toBe(
      evaluateConditionSync(condition, { value: 5 }, "if")
    );
  });

  it("rejects code-mode conditions with GRAPH_MASTRA_UNSUPPORTED_KIND", () => {
    const codeCondition: Condition = {
      type: "code",
      code: "return $input.value > 0",
    };

    expect(graphCodeOf(() => assertMastraConditionSupported(codeCondition, "n1"))).toBe(
      GRAPH_MASTRA_UNSUPPORTED_KIND
    );
  });

  it("rejects a missing condition with GRAPH_MASTRA_UNSUPPORTED_KIND", () => {
    expect(graphCodeOf(() => assertMastraConditionSupported(undefined, "n1"))).toBe(
      GRAPH_MASTRA_UNSUPPORTED_KIND
    );
  });

  it("accepts a graphical condition", () => {
    const condition: Condition = {
      op: "eq",
      left: { path: "value" },
      right: { const: 1 },
    };

    expect(graphCodeOf(() => assertMastraConditionSupported(condition, "n1"))).toBeUndefined();
  });
});
