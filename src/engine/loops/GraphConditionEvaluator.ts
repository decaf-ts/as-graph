/**
 * @module as-graph/loops/GraphConditionEvaluator
 * @summary Evaluator for built-in loop condition types and the `ConditionExpression` DSL.
 * @description Supports safe, built-in condition types only. Does NOT evaluate arbitrary JavaScript expressions.
 * When the condition object carries an `op` field (ALFRED-5 §8 / DECAF-32 §22.3), dispatches to the
 * {@link ConditionExpressionEvaluator} instead of the built-in `type`-based switch.
 */
import type { GraphConditionDefinition } from "../types";
import type { ConditionExpression } from "../../shared/graph";
import { GraphConditionType } from "../constants";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import { ConditionExpressionEvaluator } from "./ConditionExpressionEvaluator";

/**
 * Evaluates loop conditions using built-in comparison types or the
 * `ConditionExpression` DSL.
 */
export class GraphConditionEvaluator {
  private readonly expressionEvaluator = new ConditionExpressionEvaluator();

  /**
   * Evaluates a condition against the given state.
   *
   * When the condition object carries an `op` field, it is treated as a
   * `ConditionExpression` (§22.3) and dispatched to the
   * {@link ConditionExpressionEvaluator}. Otherwise the built-in `type`-based
   * switch is used.
   *
   * @param condition - The condition definition.
   * @param state - The current loop state.
   * @returns `true` when the condition passes.
   */
  evaluate(condition: GraphConditionDefinition | ConditionExpression, state: unknown): boolean {
    if (this.isConditionExpression(condition)) {
      return this.expressionEvaluator.evaluate(condition, state);
    }

    const left = this.resolveValue(condition.left, state);
    const right = condition.right;

    switch (condition.type) {
      case GraphConditionType.TRUTHY:
        return !!left;
      case GraphConditionType.FALSY:
        return !left;
      case GraphConditionType.EQUALS:
        return left === right;
      case GraphConditionType.NOT_EQUALS:
        return left !== right;
      case GraphConditionType.GREATER_THAN:
        return Number(left) > Number(right);
      case GraphConditionType.GREATER_THAN_OR_EQUAL:
        return Number(left) >= Number(right);
      case GraphConditionType.LESS_THAN:
        return Number(left) < Number(right);
      case GraphConditionType.LESS_THAN_OR_EQUAL:
        return Number(left) <= Number(right);
      case GraphConditionType.EXISTS:
        return left !== undefined && left !== null;
      case GraphConditionType.CUSTOM:
        throw new GraphExecutionError(
          "Custom condition evaluators are not supported in v1",
          "GRAPH_CUSTOM_CONDITION_UNSUPPORTED"
        );
      default:
        throw new GraphExecutionError(
          `Unknown condition type '${condition.type}'`,
          "GRAPH_UNKNOWN_CONDITION_TYPE",
          { condition }
        );
    }
  }

  /**
   * Resolves a value that may be a dotted path into the state object.
   */
  private resolveValue(path: string | undefined, state: unknown): unknown {
    if (!path) return state;
    const parts = path.split(".");
    let current: unknown = state;
    for (const part of parts) {
      if (current == null) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /**
   * Detects whether a condition object is a `ConditionExpression` (§22.3) by
   * checking for the presence of an `op` field. When true, the object is
   * treated as a `ConditionExpression` and dispatched to the
   * {@link ConditionExpressionEvaluator}.
   *
   * @returns {boolean} `true` when the condition is a `ConditionExpression`.
   */
  private isConditionExpression(condition: GraphConditionDefinition | ConditionExpression): condition is ConditionExpression {
    return typeof (condition as unknown as { op?: string }).op === "string";
  }
}
