/**
 * @module as-graph/engine/runs/bus/RedisGraphRunBus
 * @summary Run bus on Dragonfly/Redis pub/sub.
 * @description Events go to `graph:run:<runId>:events`, control messages to
 * `graph:runs:control`. One publisher and one subscriber connection per
 * process; channel subscriptions are reference-counted, so many SSE clients
 * of one run share one Redis subscription. Pub/sub is fire-and-forget: a
 * subscriber that misses a message catches up from the event store (SSE
 * replays stored events on connect).
 */
import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import type { GraphRunEventEnvelope } from "../../../shared/graph";
import type { GraphRunBus, GraphRunControlMessage } from "./GraphRunBus";

const CONTROL_CHANNEL = "graph:runs:control";
const eventChannel = (runId: string) => `graph:run:${runId}:events`;

/** {@link GraphRunBus} on Dragonfly/Redis pub/sub. */
export class RedisGraphRunBus implements GraphRunBus {
  readonly kind = "redis";
  private readonly origin = randomUUID();
  private publisher?: RedisClientType;
  private subscriber?: RedisClientType;
  private connecting?: Promise<void>;
  private readonly listeners = new Map<string, Set<(event: GraphRunEventEnvelope) => void>>();
  private readonly controlListeners = new Set<(message: GraphRunControlMessage) => void>();
  private controlSubscribed = false;

  /**
   * @param url - Dragonfly/Redis URL (e.g. `redis://127.0.0.1:6379`).
   */
  constructor(private readonly url: string) {}

  private connect(): Promise<void> {
    this.connecting ??= (async () => {
      this.publisher = createClient({ url: this.url }) as RedisClientType;
      this.subscriber = this.publisher.duplicate() as RedisClientType;
      this.publisher.on("error", () => undefined);
      this.subscriber.on("error", () => undefined);
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    })();
    return this.connecting;
  }

  async publishEvent(event: GraphRunEventEnvelope): Promise<void> {
    await this.connect();
    await this.publisher!.publish(eventChannel(event.runId), JSON.stringify(event));
  }

  async subscribeEvents(
    runId: string,
    listener: (event: GraphRunEventEnvelope) => void
  ): Promise<() => void> {
    await this.connect();
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
      await this.subscriber!.subscribe(eventChannel(runId), (message) => {
        let event: GraphRunEventEnvelope;
        try {
          event = JSON.parse(message) as GraphRunEventEnvelope;
        } catch {
          return;
        }
        for (const each of this.listeners.get(runId) ?? []) {
          try {
            each(event);
          } catch {
            // a misbehaving subscriber must not break delivery
          }
        }
      });
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(runId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(runId);
        void this.subscriber?.unsubscribe(eventChannel(runId)).catch(() => undefined);
      }
    };
  }

  async publishControl(message: GraphRunControlMessage): Promise<void> {
    await this.connect();
    await this.publisher!.publish(
      CONTROL_CHANNEL,
      JSON.stringify({ ...message, origin: this.origin })
    );
    // Local listeners hear their own process's messages too.
    for (const listener of this.controlListeners) listener(message);
  }

  async onControl(listener: (message: GraphRunControlMessage) => void): Promise<() => void> {
    await this.connect();
    this.controlListeners.add(listener);
    if (!this.controlSubscribed) {
      this.controlSubscribed = true;
      await this.subscriber!.subscribe(CONTROL_CHANNEL, (raw) => {
        let message: GraphRunControlMessage & { origin?: string };
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }
        if (message.origin === this.origin) return;
        for (const each of this.controlListeners) {
          try {
            each({ type: message.type, runId: message.runId });
          } catch {
            // ignore
          }
        }
      });
    }
    return () => this.controlListeners.delete(listener);
  }

  async ping(): Promise<boolean> {
    try {
      await this.connect();
      return (await this.publisher!.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.all([
      this.subscriber?.quit().catch(() => undefined),
      this.publisher?.quit().catch(() => undefined),
    ]);
    this.connecting = undefined;
    this.listeners.clear();
    this.controlListeners.clear();
    this.controlSubscribed = false;
  }
}
