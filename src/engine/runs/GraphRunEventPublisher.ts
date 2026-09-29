/**
 * @module as-graph/engine/runs/GraphRunEventPublisher
 * @summary Sequenced run event publishing (DECAF-50 §4.16).
 * @description Sequences and persists run events for the SSE run stream:
 * assigns a monotonically increasing `sequence` per run, stamps ISO
 * timestamps, truncates oversized/non-serializable payloads to the
 * configured limits, and chains appends per run so store writes preserve
 * publish order.
 */
import type { GraphJsonValue } from "../../shared/graph";
import {
  DEFAULT_GRAPH_RUN_LIMITS,
  type GraphRunEventEnvelope,
  type GraphRunEventEnvelopeInput,
  type GraphRunLimits,
} from "../../shared/graph";
import {
  type GraphRunEventStore,
} from "./types";

/**
 * Sequences and persists run events for the SSE run stream (DECAF-50 §4.16):
 * assigns a monotonically increasing `sequence` per run, stamps ISO
 * timestamps, truncates oversized/non-serializable payloads to the
 * configured limits, and chains appends per run so store writes preserve
 * publish order.
 */
export class GraphRunEventPublisher {
  private readonly store: GraphRunEventStore;
  private readonly limits: Required<GraphRunLimits>;
  private readonly sequences = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(store: GraphRunEventStore, limits: GraphRunLimits = {}) {
    this.store = store;
    this.limits = { ...DEFAULT_GRAPH_RUN_LIMITS, ...limits };
  }

  /**
   * Assigns the next sequence number for the run, stamps and limits the
   * payload, and appends the envelope to the store in publish order.
   */
  async publish(
    event: GraphRunEventEnvelopeInput
  ): Promise<GraphRunEventEnvelope> {
    const runId = event.runId;
    const sequence = (this.sequences.get(runId) ?? 0) + 1;
    this.sequences.set(runId, sequence);
    const envelope: GraphRunEventEnvelope = {
      ...event,
      payload: this.limitPayload(event.payload),
      sequence,
      timestamp: new Date().toISOString(),
    };
    const chained = (this.chains.get(runId) ?? Promise.resolve()).then(() =>
      this.store.append(envelope)
    );
    this.chains.set(
      runId,
      chained.catch(() => undefined)
    );
    await chained;
    return envelope;
  }

  /** Highest sequence number issued for the run (0 when none). */
  lastSequence(runId: string): number {
    return this.sequences.get(runId) ?? 0;
  }

  /** Drops sequencing state for a finished run. */
  release(runId: string): void {
    this.sequences.delete(runId);
    this.chains.delete(runId);
  }

  private limitPayload(payload: unknown): GraphJsonValue | undefined {
    if (payload === undefined) return undefined;
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return { nonSerializable: true };
    }
    if (serialized.length <= this.limits.maxEventPayloadBytes) {
      return payload as GraphRunEventEnvelope["payload"];
    }
    return {
      truncated: true,
      reason: "event payload exceeds the configured byte limit",
      bytes: serialized.length,
    };
  }
}
