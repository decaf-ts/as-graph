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
  // Only the values routed to workflow output ports: the run inputs are
  // reported on `inputs`, never mixed into `outputs`.
  // A host-supplied value store may predate `getWorkflowOutputs`; it keeps
  // the merged boundary record.
  const store = frame.valueStore as GraphExecutionFrame["valueStore"] & {
    getWorkflowOutputs?: () => GraphExecutionValues;
  };
  const outputs =
    typeof store.getWorkflowOutputs === "function"
      ? store.getWorkflowOutputs()
      : store.getWorkflowValues();
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
