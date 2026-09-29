/**
 * @module as-graph/events/GraphExecutionEventEmitter
 * @summary Observable implementation for graph execution events.
 * @description Implements Decaf's {@link Observable} interface so observers can subscribe to graph execution events. Observer failures are isolated and do not crash the workflow.
 */
import type { Observable } from "@decaf-ts/core";
import type { GraphExecutionObserver } from "./GraphExecutionObserver";
import type {
  GraphExecutionEvent,
} from "../../shared/graph";

/**
 * Manages observer registration and event dispatch for the graph execution
 * engine.
 */
export class GraphExecutionEventEmitter
  implements Observable<[GraphExecutionObserver], [GraphExecutionEvent]> {
  private readonly observers = new Set<GraphExecutionObserver>();

  /** Registers an observer and returns an unsubscribe function. */
  observe(observer: GraphExecutionObserver): () => void {
    this.observers.add(observer);
    return () => this.unObserve(observer);
  }

  /** Removes a previously-registered observer. */
  unObserve(observer: GraphExecutionObserver): void {
    this.observers.delete(observer);
  }

  /**
   * Notifies all registered observers of a new event.
   *
   * Observer failures are caught and swallowed so that a misbehaving observer
   * cannot crash the workflow execution.
   */
  async updateObservers(event: GraphExecutionEvent): Promise<void> {
    await Promise.all(
      Array.from(this.observers).map(async (observer) => {
        try {
          await Promise.resolve(observer.refresh(event));
        } catch {
          // Observer failures must not crash execution.
        }
      })
    );
  }
}
