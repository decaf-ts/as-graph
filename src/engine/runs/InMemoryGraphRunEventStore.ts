/**
 * @module as-graph/engine/runs/InMemoryGraphRunEventStore
 * @summary In-memory reference run event store.
 * @description Non-persistent {@link GraphRunEventStore} backed by per-run
 * arrays: appends notify live subscribers, `listAfter` serves SSE replays,
 * and retention keeps at most `maxEventsPerRun` envelopes per run — evicting
 * non-terminal events first so terminal outcomes are never dropped.
 */
import type {
  GraphRunEventEnvelope,
} from "../../shared/graph";
import type {
  GraphRunEventStore,
} from "./types";
import {
  DEFAULT_GRAPH_RUN_LIMITS,
  isGraphRunTerminalEventType,
  type GraphRunLimits,
} from "../../shared/graph";

/**
 * Non-persistent {@link GraphRunEventStore} backed by per-run arrays:
 * appends notify live subscribers, `listAfter` serves SSE replays, and
 * retention keeps at most `maxEventsPerRun` envelopes per run — evicting
 * non-terminal events first so terminal outcomes are never dropped.
 */
export class InMemoryGraphRunEventStore implements GraphRunEventStore {
  private readonly events = new Map<string, GraphRunEventEnvelope[]>();
  private readonly listeners = new Map<
    string,
    Set<(event: GraphRunEventEnvelope) => void>
  >();
  private readonly limits: Required<GraphRunLimits>;

  constructor(limits: GraphRunLimits = {}) {
    this.limits = { ...DEFAULT_GRAPH_RUN_LIMITS, ...limits };
  }

  async append(event: GraphRunEventEnvelope): Promise<void> {
    let list = this.events.get(event.runId);
    if (!list) {
      list = [];
      this.events.set(event.runId, list);
    }
    list.push(event);
    this.enforceRetention(list);
    for (const listener of this.listeners.get(event.runId) ?? []) {
      try {
        listener(event);
      } catch {
        // a misbehaving subscriber must not break the append pipeline
      }
    }
  }

  async listAfter(
    runId: string,
    sequence: number
  ): Promise<GraphRunEventEnvelope[]> {
    const list = this.events.get(runId);
    if (!list) return [];
    return list.filter((event) => event.sequence > sequence);
  }

  subscribe(
    runId: string,
    listener: (event: GraphRunEventEnvelope) => void
  ): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  release(runId: string): void {
    this.events.delete(runId);
    this.listeners.delete(runId);
  }

  private enforceRetention(list: GraphRunEventEnvelope[]): void {
    const max = this.limits.maxEventsPerRun;
    while (list.length > max) {
      const evictIndex = list.findIndex(
        (event) => !isGraphRunTerminalEventType(event.type)
      );
      if (evictIndex === -1) break;
      list.splice(evictIndex, 1);
    }
  }
}
