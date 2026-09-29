/**
 * @module as-graph/loops/ConditionExpressionEvaluator
 * @summary Evaluator for the ALFRED-5 `ConditionExpression` DSL (DECAF-32 §22.3).
 * @description Evaluates declarative, serializable condition expressions with
 * `eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`and`/`or`/`not`/`exists` operators and
 * `ExprValue` references (`{const}`, `{path}`, `{step, path}`).
 */
import type { ConditionExpression, ExprValue } from "../../shared/graph";
import { GraphExecutionError } from "../errors/GraphExecutionError";

/**
 * Evaluates a {@link ConditionExpression} against the given state.
 *
 * `ExprValue` resolution:
 * - `{ const: x }` → the literal value `x`.
 * - `{ path: "a.b" }` → dotted-path lookup into `state`.
 * - `{ step: "nodeId", path: "out" }` → cross-node reference; in v1 the state
 *   is expected to contain a `nodes` map keyed by node id (reserved for future
 *   multi-step evaluation; falls back to `state` lookup when absent).
 */
export class ConditionExpressionEvaluator {
  /**
   * Evaluates a condition expression to a boolean.
   *
   * @param expr - The condition expression.
   * @param state - The current evaluation state (loop state or execution values).
   * @returns `true` when the expression evaluates to a truthy/positive result.
   */
  evaluate(expr: ConditionExpression, state: unknown): boolean {
    switch (expr.op) {
      case "eq":
        return this.resolveValue(expr.left, state) === this.resolveValue(expr.right, state);
      case "neq":
        return this.resolveValue(expr.left, state) !== this.resolveValue(expr.right, state);
      case "gt":
        return Number(this.resolveValue(expr.left, state)) > Number(this.resolveValue(expr.right, state));
      case "gte":
        return Number(this.resolveValue(expr.left, state)) >= Number(this.resolveValue(expr.right, state));
      case "lt":
        return Number(this.resolveValue(expr.left, state)) < Number(this.resolveValue(expr.right, state));
      case "lte":
        return Number(this.resolveValue(expr.left, state)) <= Number(this.resolveValue(expr.right, state));
      case "and":
        return expr.conditions.every((c) => this.evaluate(c, state));
      case "or":
        return expr.conditions.some((c) => this.evaluate(c, state));
      case "not":
        return !this.evaluate(expr.condition, state);
      case "exists":
        return this.resolveValue(expr.value, state) !== undefined && this.resolveValue(expr.value, state) !== null;
      default:
        throw new GraphExecutionError(
          `Unknown ConditionExpression op '${(expr as { op: string }).op}'`,
          "GRAPH_UNKNOWN_CONDITION_OP",
          { expr }
        );
    }
  }

  /**
   * Resolves an {@link ExprValue} against the current state.
   */
  private resolveValue(ref: ExprValue, state: unknown): unknown {
    if ("const" in ref) {
      return ref.const;
    }
    if ("path" in ref && !("step" in ref)) {
      return this.resolvePath(ref.path, state);
    }
    if ("step" in ref && "path" in ref) {
      const nodes = (state as Record<string, unknown> | null)?.["nodes"];
      if (nodes && typeof nodes === "object") {
        const nodeState = (nodes as Record<string, unknown>)[ref.step];
        return this.resolvePath(ref.path, nodeState);
      }
      return this.resolvePath(ref.path, state);
    }
    throw new GraphExecutionError(
      "Invalid ExprValue: must have `const`, `path`, or `step`+`path`",
      "GRAPH_INVALID_EXPR_VALUE",
      { ref }
    );
  }

  /**
   * Resolves a dotted path into a target object.
   */
  private resolvePath(path: string, target: unknown): unknown {
    if (!path) return target;
    const parts = path.split(".");
    let current: unknown = target;
    for (const part of parts) {
      if (current == null) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
