/**
 * @module as-graph/mastra/MastraConditionBridge
 * @summary Bridge between canonical graph conditions and Mastra branch
 * predicates (SAA-196).
 * @description Mastra cannot represent code-mode conditions, so translation
 * fails closed for them; every other canonical condition is wrapped into a
 * synchronous predicate that delegates to the engine's shared condition
 * evaluator, keeping branch semantics identical to the local backend.
 */
import type { Condition } from "../shared/graph";
import { isCodeCondition, evaluateConditionSync } from "../engine/loops/ConditionEvaluator";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import { GRAPH_MASTRA_UNSUPPORTED_KIND } from "./types";

/** Arguments the Mastra runtime passes into a branch predicate. */
export interface MastraBranchPredicateArgs {
  /** The step input data of the branch step. */
  inputData?: unknown;
  /** The workflow state available to the branch step. */
  state?: unknown;
}

/**
 * Guards that a flow-control node's condition is translatable by the Mastra
 * backend: it must exist and must not be a code-mode condition.
 *
 * @param condition - The condition attached to the flow-control node.
 * @param nodeId - The document node id used in error payloads.
 * @returns Nothing; returns only when the condition is translatable.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_UNSUPPORTED_KIND} when the
 *   condition is missing or is a code-mode condition.
 */
export function assertMastraConditionSupported(
  condition: Condition | undefined,
  nodeId: string
): void {
  if (!condition) {
    throw new GraphExecutionError(
      `Mastra flow-control node '${nodeId}' has no condition to translate`,
      GRAPH_MASTRA_UNSUPPORTED_KIND,
      { nodeId }
    );
  }
  if (isCodeCondition(condition)) {
    throw new GraphExecutionError(
      `Mastra backend cannot translate code-mode condition on node '${nodeId}'`,
      GRAPH_MASTRA_UNSUPPORTED_KIND,
      { nodeId, kind: "code-condition" }
    );
  }
}

/**
 * Wraps a canonical condition into a synchronous Mastra branch predicate. The
 * predicate receives the runtime's step arguments and evaluates the condition
 * against the step input data, falling back to the workflow state.
 *
 * @param condition - The canonical condition to evaluate.
 * @param label - Diagnostic label used in evaluation errors.
 * @returns The synchronous predicate Mastra branch steps call.
 */
export function mastraConditionPredicate(
  condition: Condition,
  label: string
): (args: MastraBranchPredicateArgs) => boolean {
  return (args: MastraBranchPredicateArgs): boolean =>
    evaluateConditionSync(condition, args?.inputData ?? args?.state, label);
}
