/**
 * @module as-graph/loops/GraphConditionEvaluator
 * @summary Evaluator for built-in loop condition types, the `ConditionExpression` DSL, and `CodeCondition` code mode.
 * @description Supports safe, built-in condition types, the declarative `ConditionExpression` DSL, and — through the
 * shared {@link evaluateCondition} dispatch — pluggable `CodeCondition` code mode. When the condition object carries an
 * `op` field (ALFRED-5 §8 / DECAF-32 §22.3) it dispatches to the {@link ConditionExpressionEvaluator}; when it carries
 * `type: "code"` (DECAF-32 §22.4) it dispatches to the registered `CodeSandboxEvaluator`; otherwise the built-in
 * `type`-based switch is used.
 */
import type { GraphConditionDefinition, LoopCondition } from "../types";
import type { ConditionExpression } from "../../shared/graph";
import type { GraphExecutionContext } from "../execution/GraphExecutionContext";
import { GraphConditionType } from "../constants";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import { ConditionExpressionEvaluator } from "./ConditionExpressionEvaluator";
import { isCodeCondition, evaluateCodeCondition } from "./ConditionEvaluator";

/**
 * Evaluates loop conditions using built-in comparison types, the
 * `ConditionExpression` DSL, or the pluggable code sandbox.
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
   * Evaluates a loop condition that may be a built-in `GraphConditionDefinition`,
   * a graphical `ConditionExpression`, or a code `CodeCondition`.
   *
   * `CodeCondition` evaluation is asynchronous (it runs through the pluggable
   * `CodeSandboxEvaluator`), so the loop nodes call this method instead of the
   * synchronous {@link evaluate}. Graphical and built-in conditions delegate to
   * {@link evaluate} unchanged.
   *
   * @param condition - The condition definition.
   * @param state - The current loop state (the graphical resolution root).
   * @param context - The run-scoped execution context.
   * @param input - The value map exposed to code conditions as `$input`.
   * @returns `true` when the condition passes.
   * @throws {GraphExecutionError} When no code sandbox evaluator is registered.
   */
  async evaluateAsync(
    condition: LoopCondition,
    state: unknown,
    context: GraphExecutionContext,
    input: Record<string, unknown>
  ): Promise<boolean> {
    if (isCodeCondition(condition)) {
      return evaluateCodeCondition(condition, input, context);
    }
    return this.evaluate(condition, state);
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
