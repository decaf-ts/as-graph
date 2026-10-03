/**
 * @module as-graph/loops/ConditionEvaluator
 * @summary Shared dispatch for graphical and code conditions (DECAF-32 §22.3–22.4).
 * @description The single authority that evaluates a condition carried by any
 * flow-control node (if, elseIf, while, until, switch):
 *
 * - a `ConditionExpression` (graphical mode) is dispatched to the
 *   {@link ConditionExpressionEvaluator};
 * - a `CodeCondition` (code mode) is dispatched to the pluggable
 *   `CodeSandboxEvaluator` registered on `GraphExecutionEngineConfig`.
 *
 * Extracted from the switch node so the if node and the loop condition evaluator
 * reuse exactly the same semantics — including the
 * `GRAPH_CODE_SANDBOX_NOT_CONFIGURED` failure mode — instead of duplicating it.
 */
import type { Condition, ConditionExpression, CodeCondition } from "../../shared/graph";
import type { GraphExecutionContext } from "../execution/GraphExecutionContext";
import type {
  CodeSandboxEvaluator,
  SandboxLogger,
} from "../execution/CodeSandboxEvaluator";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import { ConditionExpressionEvaluator } from "./ConditionExpressionEvaluator";

/**
 * Detects whether a condition is a {@link CodeCondition} (code mode) by checking
 * for a `type` field equal to `"code"`.
 *
 * @param condition - The condition to inspect.
 * @returns `true` when the condition is a `CodeCondition`.
 */
export function isCodeCondition(condition: unknown): condition is CodeCondition {
  return (
    typeof condition === "object" &&
    condition !== null &&
    "type" in condition &&
    (condition as { type?: unknown }).type === "code"
  );
}

/**
 * Detects whether a condition is a {@link ConditionExpression} (graphical mode) by
 * checking for a string `op` field.
 *
 * @param condition - The condition to inspect.
 * @returns `true` when the condition is a `ConditionExpression`.
 */
export function isConditionExpression(
  condition: unknown
): condition is ConditionExpression {
  return (
    typeof condition === "object" &&
    condition !== null &&
    "op" in condition &&
    typeof (condition as { op?: unknown }).op === "string"
  );
}

/**
 * Evaluates a {@link CodeCondition} through the `CodeSandboxEvaluator` registered
 * on the execution engine (DECAF-32 §22.4).
 *
 * The sandbox context exposes the run's `$input`, `$vars`, `$item`, `$index`, and
 * `$node` values, mirroring the switch node. When no evaluator is registered the
 * call fails with `GRAPH_CODE_SANDBOX_NOT_CONFIGURED`, the same failure mode as
 * every other code-mode condition path.
 *
 * @param condition - The code condition to evaluate.
 * @param input - The value map exposed to the sandbox as `$input`.
 * @param context - The run-scoped execution context.
 * @returns `true` when the sandbox result is truthy.
 * @throws {GraphExecutionError} When no evaluator is registered or the sandbox fails.
 */
export async function evaluateCodeCondition(
  condition: CodeCondition,
  input: Record<string, unknown>,
  context: GraphExecutionContext
): Promise<boolean> {
  const evaluator = (
    context.engine as { codeSandboxEvaluator?: CodeSandboxEvaluator } | undefined
  )?.codeSandboxEvaluator;
  if (!evaluator) {
    throw new GraphExecutionError(
      "Code conditions require a CodeSandboxEvaluator to be registered in GraphExecutionEngineConfig.codeSandboxEvaluator",
      "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
      { code: condition.code }
    );
  }
  await context.log("Evaluating code condition", {
    language: condition.language ?? "javascript",
  });
  const md = context.metadata as Record<string, unknown> | undefined;
  const result = await evaluator.evaluate({
    code: condition.code,
    language: condition.language,
    input,
    vars: (md?.vars as Record<string, unknown> | undefined) ?? undefined,
    item: md?.item,
    index: md?.index as number | undefined,
    nodes:
      (md?.nodes as Record<string, Record<string, unknown>> | undefined) ??
      undefined,
    logger: context.logger as unknown as SandboxLogger | undefined,
    abortSignal: context.abortSignal,
  });
  return !!result;
}

/**
 * Options for {@link evaluateCondition}.
 */
export interface ConditionEvaluationOptions {
  /** The value map exposed to code conditions as `$input`. */
  input: Record<string, unknown>;
  /** The state a graphical `ConditionExpression` resolves against. */
  state: unknown;
  /**
   * Human label for the carrier used in the unknown-condition error message
   * (e.g. `"switch case"`, `"if"`, `"loop"`).
   */
  label?: string;
}

/**
 * Evaluates a graphical {@link ConditionExpression} synchronously, throwing for
 * any other shape. Used by synchronous executors that must preserve their
 * synchronous throw contract for graphical conditions.
 *
 * @param condition - The condition to evaluate.
 * @param state - The state a graphical `ConditionExpression` resolves against.
 * @param label - Human label for the carrier used in the unknown-condition error.
 * @returns `true` when the expression matches.
 * @throws {GraphExecutionError} When the condition is not a `ConditionExpression`.
 */
export function evaluateConditionSync(
  condition: unknown,
  state: unknown,
  label?: string
): boolean {
  if (isConditionExpression(condition)) {
    return new ConditionExpressionEvaluator().evaluate(condition, state);
  }
  throw unknownConditionError(condition, label);
}

/**
 * Evaluates a {@link Condition} carried by any flow-control node, dispatching
 * graphical expressions to the {@link ConditionExpressionEvaluator} and code
 * conditions to the registered `CodeSandboxEvaluator`.
 *
 * @param condition - The condition to evaluate.
 * @param options - The sandbox input, graphical state, and error label.
 * @param context - The run-scoped execution context.
 * @returns `true` when the condition matches.
 * @throws {GraphExecutionError} When the condition shape is unknown.
 */
export async function evaluateCondition(
  condition: Condition,
  options: ConditionEvaluationOptions,
  context: GraphExecutionContext
): Promise<boolean> {
  if (isCodeCondition(condition)) {
    return evaluateCodeCondition(condition, options.input, context);
  }
  return evaluateConditionSync(condition, options.state, options.label);
}

/**
 * Builds the error thrown when a condition is neither a
 * {@link ConditionExpression} nor a {@link CodeCondition}.
 */
function unknownConditionError(
  condition: unknown,
  label?: string
): GraphExecutionError {
  return new GraphExecutionError(
    `Unknown ${label ?? "flow"} condition type — must be ConditionExpression (op) or CodeCondition (type: 'code')`,
    "GRAPH_UNKNOWN_CONDITION_TYPE",
    { condition }
  );
}
