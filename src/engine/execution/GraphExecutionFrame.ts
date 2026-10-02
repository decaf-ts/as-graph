/**
 * @module as-graph/execution/GraphExecutionFrame
 * @summary Per-run state container for graph execution.
 * @description Holds the run id, execution plan, value store, accumulated node results, events, and timing for a single workflow execution.
 */
import type { GraphExecutionPlan } from "../planning/GraphExecutionPlan";
import type { GraphValueRepository } from "../store/GraphValueRepository";
import type { GraphExecutionEventFactory } from "../events/GraphExecutionEventFactory";
import type {
  GraphExecutionEvent,
} from "../../shared/graph";
import type {
  GraphNodeExecutionResult,
  GraphRunId,
} from "../types";

/**
 * Mutable state for a single graph execution run.
 */
export class GraphExecutionFrame {
  /** Unique id of the run this frame tracks. */
  readonly runId: GraphRunId;
  /** Topologically layered execution plan driving the run. */
  readonly plan: GraphExecutionPlan;
  /** Value store routing routed port values between nodes. */
  readonly valueStore: GraphValueRepository;
  /** Factory building typed execution events for the run. */
  readonly eventFactory: GraphExecutionEventFactory;
  /** Timestamp taken when the frame was created. */
  readonly startedAt: Date;
  /** Per-node execution results accumulated during the run, keyed by node id. */
  readonly nodeResults: Map<string, GraphNodeExecutionResult> = new Map();
  /** Ordered event log of the run. */
  readonly events: GraphExecutionEvent[] = [];
  /**
   * Ids of the data edges activated by a routed upstream output port
   * (DECAF-50 §4.9 branch semantics). A data edge is activated only when
   * its source node actually emitted the edge's source port; downstream
   * nodes with no activated incoming data edge are skipped rather than run
   * with undefined inputs.
   */
  private readonly activeDataEdges: Set<string> = new Set();

  /** Timestamp taken when {@link finish} was called; undefined while running. */
  finishedAt?: Date;

  constructor(
    runId: GraphRunId,
    plan: GraphExecutionPlan,
    valueStore: GraphValueRepository,
    eventFactory: GraphExecutionEventFactory
  ) {
    this.runId = runId;
    this.plan = plan;
    this.valueStore = valueStore;
    this.eventFactory = eventFactory;
    this.startedAt = new Date();
  }

  /** Records a node execution result. */
  recordNodeResult(result: GraphNodeExecutionResult): void {
    this.nodeResults.set(result.nodeId, result);
  }

  /** Marks a data edge as activated by its routed source output port. */
  activateDataEdge(edgeId: string): void {
    this.activeDataEdges.add(edgeId);
  }

  /** Returns whether a data edge has been activated during this run. */
  isDataEdgeActive(edgeId: string): boolean {
    return this.activeDataEdges.has(edgeId);
  }

  /** Appends an event to the run's event log. */
  appendEvent(event: GraphExecutionEvent): void {
    this.events.push(event);
  }

  /** Marks the run as finished. */
  finish(): void {
    this.finishedAt = new Date();
  }
}
