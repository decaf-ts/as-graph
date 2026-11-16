/**
 * @module as-graph/nodes/flow/child-run
 * @summary Shared guard for nodes that execute a nested workflow run.
 * @description `GraphExecutionEngine.execute` reports a failed run through its
 * returned result (status `failed`, the failing node's error) instead of
 * throwing. A node that runs a nested document — a loop body, a sub-workflow —
 * must therefore check the child result itself. Without the check a failed
 * body is indistinguishable from one that produced no output: `foreach`
 * collected `undefined` for the iteration and carried on, and a `while` loop
 * kept re-running a body that fails every time until it hit its iteration cap.
 */
import { GraphExecutionStatus } from "../../shared/graph";
import type { GraphExecutionResult } from "../../engine/types";
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";

/**
 * Fails the calling node when its nested run did not succeed.
 *
 * The child's first failed node supplies the error code and message, so the
 * parent run reports the real cause rather than a generic wrapper.
 *
 * @param child - The nested run's result.
 * @param label - What the nested run was, for the error message (for example
 * `"foreach iteration 2"`).
 * @returns The child result, unchanged, when it succeeded.
 * @throws {GraphExecutionError} carrying the child's failure when the nested
 * run failed or was cancelled.
 */
export function assertChildRunSucceeded(
  child: GraphExecutionResult,
  label: string
): GraphExecutionResult {
  const status = child?.status;
  if (
    status !== GraphExecutionStatus.FAILED &&
    status !== GraphExecutionStatus.CANCELLED
  ) {
    return child;
  }
  const failure = Object.values(child.nodeResults ?? {}).find(
    (result) => result.status === GraphExecutionStatus.FAILED
  );
  const reason =
    failure?.error?.message ??
    (status === GraphExecutionStatus.CANCELLED
      ? "the nested run was cancelled"
      : "the nested run failed");
  throw new GraphExecutionError(
    `${label} failed: ${reason}`,
    failure?.error?.code ?? "GRAPH_CHILD_RUN_FAILED",
    {
      childRunId: child.runId,
      ...(failure ? { nodeId: failure.nodeId } : {}),
      ...(failure?.error?.details ? { cause: failure.error.details } : {}),
    }
  );
}
