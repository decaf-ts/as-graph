/**
 * @module as-graph/events/GraphExecutionObserver
 * @summary Observer interface for graph execution events.
 * @description Extends Decaf's {@link Observer} so graph events flow through the standard Observable/Observer pipeline.
 */
import type { Observer } from "@decaf-ts/core";
import type {
  GraphExecutionEvent,
} from "../../shared/graph";

/**
 * Observer that receives {@link GraphExecutionEvent} instances from the
 * graph execution engine.
 */
export interface GraphExecutionObserver extends Observer<[GraphExecutionEvent]> {
  /**
   * Called by the engine when a new graph execution event is emitted.
   */
  refresh(event: GraphExecutionEvent): Promise<void>;
}
