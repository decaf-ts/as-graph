/**
 * @module as-graph/engine/runs/bus/GraphRunBus
 * @summary Cross-process fan-out of run events and run control messages.
 * @description With more than one backend process, the process serving a
 * run's SSE stream is rarely the one executing it. The bus carries:
 *
 * - **events** — every appended envelope is published on the run's channel;
 *   a subscriber in any process receives it (after replaying stored events);
 * - **control** — `cancel` requests reach the worker that owns the run.
 *
 * {@link InProcessGraphRunBus} (default) keeps both inside one process;
 * `RedisGraphRunBus` uses Dragonfly/Redis pub/sub. {@link BusGraphRunEventStore}
 * wraps any event store so appends are also published and subscriptions also
 * listen to the bus, de-duplicating by sequence.
 */
import type { GraphRunEventEnvelope } from "../../../shared/graph";
import type { GraphRunEventStore } from "../types";

/** A run control message. */
export interface GraphRunControlMessage {
  type: "cancel";
  runId: string;
}

/** Cross-process channel for run events and control. */
export interface GraphRunBus {
  /** Implementation name (`in-process`, `redis`). */
  readonly kind: string;
  /** Publishes an appended event envelope. */
  publishEvent(event: GraphRunEventEnvelope): Promise<void>;
  /** Listens to a run's events from every process; returns an unsubscribe. */
  subscribeEvents(
    runId: string,
    listener: (event: GraphRunEventEnvelope) => void
  ): Promise<() => void>;
  /** Publishes a control message to every process. */
  publishControl(message: GraphRunControlMessage): Promise<void>;
  /** Listens to control messages; returns an unsubscribe. */
  onControl(listener: (message: GraphRunControlMessage) => void): Promise<() => void>;
  /** Liveness of the bus (readiness probe). */
  ping(): Promise<boolean>;
  /** Closes connections. */
  close(): Promise<void>;
}

/** A bus that never leaves the process (single-process deployments). */
export class InProcessGraphRunBus implements GraphRunBus {
  readonly kind = "in-process";
  private readonly events = new Map<string, Set<(event: GraphRunEventEnvelope) => void>>();
  private readonly control = new Set<(message: GraphRunControlMessage) => void>();

  async publishEvent(event: GraphRunEventEnvelope): Promise<void> {
    for (const listener of this.events.get(event.runId) ?? []) {
      try {
        listener(event);
      } catch {
        // a misbehaving subscriber must not break publishing
      }
    }
  }

  async subscribeEvents(
    runId: string,
    listener: (event: GraphRunEventEnvelope) => void
  ): Promise<() => void> {
    let set = this.events.get(runId);
    if (!set) {
      set = new Set();
      this.events.set(runId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.events.delete(runId);
    };
  }

  async publishControl(message: GraphRunControlMessage): Promise<void> {
    for (const listener of this.control) {
      try {
        listener(message);
      } catch {
        // ignore
      }
    }
  }

  async onControl(listener: (message: GraphRunControlMessage) => void): Promise<() => void> {
    this.control.add(listener);
    return () => this.control.delete(listener);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.events.clear();
    this.control.clear();
  }
}

/**
 * Event store decorator: appends are persisted by the wrapped store and also
 * published on the bus; a subscription listens both to local appends and to
 * the bus, delivering each sequence once.
 */
export class BusGraphRunEventStore implements GraphRunEventStore {
  constructor(
    private readonly inner: GraphRunEventStore,
    private readonly bus: GraphRunBus
  ) {}

  async append(event: GraphRunEventEnvelope): Promise<void> {
    await this.inner.append(event);
    await this.bus.publishEvent(event).catch(() => undefined);
  }

  listAfter(runId: string, sequence: number): Promise<GraphRunEventEnvelope[]> {
    return this.inner.listAfter(runId, sequence);
  }

  subscribe(
    runId: string,
    listener: (event: GraphRunEventEnvelope) => void
  ): () => void {
    let last = 0;
    const deliver = (event: GraphRunEventEnvelope) => {
      if (event.sequence <= last) return;
      last = event.sequence;
      listener(event);
    };
    const local = this.inner.subscribe(runId, deliver);
    let remote: (() => void) | undefined;
    let closed = false;
    void this.bus
      .subscribeEvents(runId, deliver)
      .then((unsubscribe) => {
        if (closed) unsubscribe();
        else remote = unsubscribe;
      })
      .catch(() => undefined);
    return () => {
      closed = true;
      local();
      remote?.();
    };
  }

  release(runId: string): void | Promise<void> {
    return this.inner.release?.(runId);
  }

  lastSequence(runId: string): Promise<number> {
    return this.inner.lastSequence?.(runId) ?? Promise.resolve(0);
  }
}
