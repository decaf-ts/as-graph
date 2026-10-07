/**
 * @module as-graph/dagster/DagsterResultMapper
 * @summary Maps a terminal Dagster run onto an engine-agnostic result (SAA-195).
 * @description Assembles the canonical {@link GraphExecutionResult} from the
 * terminal Dagster run record and the node results the event bridge collected.
 * Error payloads are frontend-safe: raw Dagster details never reach clients.
 */
import type {
  GraphExecutionEvent,
  GraphWorkflowDocument,
} from "../shared/graph";
import { GraphExecutionStatus } from "../shared/graph";
import type { GraphExecutionErrorPayload } from "../shared/graph";
import type {
  GraphExecutionOptions,
  GraphExecutionResult,
  GraphExecutionValues,
  GraphNodeExecutionResult,
} from "../engine/types";
import type { DagsterRunRecord } from "./DagsterTypes";

/** Input to {@link DagsterResultMapper.map}. */
export interface DagsterResultMapperInput {
  /** Dagster run id. */
  runId: string;
  /** Canonical document of the inspected job. */
  document: GraphWorkflowDocument;
  /** The run's workflow input values. */
  inputs: GraphExecutionValues;
  /** Effective execution options. */
  options: GraphExecutionOptions;
  /** The terminal Dagster run record. */
  record: DagsterRunRecord;
  /** Node results collected by the event bridge. */
  nodeResults: Record<string, GraphNodeExecutionResult>;
  /** Events collected by the event bridge. */
  events: GraphExecutionEvent[];
}

/**
 * Maps terminal Dagster run records onto canonical execution results.
 */
export class DagsterResultMapper {
  /**
   * Maps a terminal run record and collected node results to a
   * {@link GraphExecutionResult}.
   *
   * @param input - The mapping input.
   * @returns The canonical execution result.
   */
  map(input: DagsterResultMapperInput): GraphExecutionResult {
    const startedAt = input.record.startedAt
      ? new Date(input.record.startedAt)
      : new Date();
    const finishedAt = input.record.finishedAt
      ? new Date(input.record.finishedAt)
      : new Date();
    return {
      runId: input.runId,
      workflowId: input.document.id || input.document.name,
      status: this.statusOf(input.record),
      document: input.document,
      inputs: { ...input.inputs },
      outputs: { ...(input.record.outputs ?? {}) },
      nodeResults: input.nodeResults,
      events: input.events,
      startedAt,
      finishedAt,
      metadata: input.options.metadata,
    };
  }

  /**
   * Maps a terminal Dagster run status to an engine-agnostic status.
   *
   * @param record - The terminal run record.
   * @returns The engine-agnostic status.
   */
  private statusOf(record: DagsterRunRecord): GraphExecutionStatus {
    switch (record.status) {
      case "success":
        return GraphExecutionStatus.SUCCEEDED;
      case "canceled":
        return GraphExecutionStatus.CANCELLED;
      default:
        return GraphExecutionStatus.FAILED;
    }
  }
}

/** Re-exported for typing clarity. */
export type { GraphExecutionErrorPayload };
