/**
 * @module as-graph/execution/GraphExecutionResult
 * @summary Helper for building GraphExecutionResult objects.
 * @description Provides a builder function that assembles a result from a frame.
 */
import type { GraphWorkflowDocument } from "../../shared/graph";
import type { GraphExecutionFrame } from "./GraphExecutionFrame";
import type {
  GraphExecutionEvent,
} from "../../shared/graph";
import type {
  GraphExecutionResult,
  GraphExecutionValues,
  GraphNodeExecutionResult,
  GraphRunId,
} from "../types";
import type { GraphExecutionStatus } from "../../shared/graph";

/**
 * Builds a {@link GraphExecutionResult} from a completed frame.
 */
export function buildGraphExecutionResult(
  frame: GraphExecutionFrame,
  document: GraphWorkflowDocument,
  inputs: GraphExecutionValues,
  status: GraphExecutionStatus,
  metadata?: Record<string, unknown>
): GraphExecutionResult {
  const outputs = frame.valueStore.getWorkflowValues();
  const nodeResults: Record<string, GraphNodeExecutionResult> = {};
  for (const [id, result] of frame.nodeResults) {
    nodeResults[id] = result;
  }
  const events: GraphExecutionEvent[] = [...frame.events];
  const runId: GraphRunId = frame.runId;

  return {
    runId,
    workflowId: document.id || document.name,
    status,
    document,
    inputs: { ...inputs },
    outputs,
    nodeResults,
    events,
    startedAt: frame.startedAt,
    finishedAt: frame.finishedAt,
    metadata,
  };
}
