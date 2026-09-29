/**
 * @module as-graph/events/GraphExecutionEventFactory
 * @summary Factory for creating graph execution events with unique ids, sequence numbers, and timestamps.
 * @description Provides a stateful factory that produces monotonically-sequenced events for a single execution run.
 */
import type {
  GraphExecutionEvent,
} from "../../shared/graph";
import { GraphExecutionError } from "../errors";

/**
 * Factory that enriches partial events with a unique id, an incrementing
 * sequence number, and a timestamp.
 */
export class GraphExecutionEventFactory {
  private sequence = 0;

  /**
   * Creates a fully-populated event from the given base fields.
   *
   * @param base - All event fields except `id`, `sequence`, and `timestamp`.
   * @returns A complete {@link GraphExecutionEvent}.
   */
  create(
    base: Omit<GraphExecutionEvent, "id" | "sequence" | "timestamp">
  ): GraphExecutionEvent {
    return {
      ...base,
      id: this.createEventId(),
      sequence: ++this.sequence,
      timestamp: new Date(),
    };
  }

  /**
   * Generates a cryptographically random event id. `crypto.randomUUID` is
   * always available in the backend runtimes as-graph targets; if it is
   * somehow unavailable the factory fails loudly rather than falling back to a
   * predictable, guessable id.
   *
   * @throws {GraphExecutionError} when `crypto.randomUUID` is unavailable.
   */
  private createEventId(): string {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.randomUUID !== "function") {
      throw new GraphExecutionError(
        "Cannot generate a graph event id: crypto.randomUUID is unavailable in this runtime",
        "GRAPH_EVENT_ID_ERROR",
        { runtime: typeof globalThis.crypto }
      );
    }
    return cryptoApi.randomUUID();
  }
}
