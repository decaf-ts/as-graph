/**
 * @module as-graph/ram/GraphRunEventStore
 * @summary Adapter-backed graph run event store (DECAF-50 §4.14–§4.16).
 * @description Repository-backed {@link GraphRunEventStore}: envelopes are
 * persisted as {@link GraphRunEventModel} rows through a provided Decaf adapter.
 * Live subscribers are kept in-process (a listener cannot be serialized); replay
 * reads come from the adapter. Retention uses {@link GraphRunLimits}.
 */
import {
  Repository,
  repository,
  type Adapter,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import { DefaultFlavour } from "@decaf-ts/decoration";
import type { GraphRunEventEnvelope } from "../shared/graph";
import {
  DEFAULT_GRAPH_RUN_LIMITS,
  isGraphRunTerminalEventType,
  type GraphExecutionEventType,
  type GraphRunLimits,
} from "../shared/graph";
import type { GraphRunEventStore } from "../engine/runs/types";
import {
  envelopeToModel,
  GraphRunEventModel,
  modelToEnvelope,
} from "./GraphRunEventModel";

/** Repository for {@link GraphRunEventModel} rows. */
@repository(GraphRunEventModel, DefaultFlavour)
export class GraphRunEventRepository extends Repository<
  GraphRunEventModel,
  Adapter<any, any, any, any>
> {
  constructor(adapter?: Adapter<any, any, any, any>) {
    super(adapter, GraphRunEventModel);
  }
}

/**
 * Adapter-backed {@link GraphRunEventStore}. Requires a provided adapter; the
 * caller owns adapter initialization and lifecycle. Live subscribers stay
 * in-process; persisted events are served by the adapter.
 */
export class RamGraphRunEventStore implements GraphRunEventStore {
  private readonly repo: GraphRunEventRepository;
  private readonly listeners = new Map<
    string,
    Set<(event: GraphRunEventEnvelope) => void>
  >();
  private readonly limits: Required<GraphRunLimits>;

  constructor(
    adapter: Adapter<any, any, any, any>,
    limits: GraphRunLimits = {}
  ) {
    this.repo = Repository.forModel(
      GraphRunEventModel,
      adapter.alias
    ) as GraphRunEventRepository;
    this.limits = { ...DEFAULT_GRAPH_RUN_LIMITS, ...limits };
  }

  /**
   * Appends an event envelope, enforces the run retention limit, and
   * notifies in-process subscribers (subscriber errors are swallowed).
   *
   * @param {GraphRunEventEnvelope} event - Envelope to persist and broadcast.
   * @return {Promise<void>} Resolves once the row is persisted and retention applied.
   */
  async append(event: GraphRunEventEnvelope): Promise<void> {
    await this.repo.create(envelopeToModel(event));
    await this.enforceRetention(event.runId);
    for (const listener of this.listeners.get(event.runId) ?? []) {
      try {
        listener(event);
      } catch {
        // a misbehaving subscriber must not break the append pipeline
      }
    }
  }

  /**
   * Replays a run's events with a sequence strictly greater than the given
   * one, in ascending sequence order.
   *
   * @param {string} runId - Run whose events to list.
   * @param {number} sequence - Sequence number to list events after.
   * @param args - Optional decaf `Context` arguments forwarded to the repository.
   * @return {Promise<GraphRunEventEnvelope[]>} The replayed envelopes in sequence order.
   */
  async listAfter(
    runId: string,
    sequence: number,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRunEventEnvelope[]> {
    const models = (await this.repo.select().execute(
      ...args
    )) as GraphRunEventModel[];
    return models
      .filter((model) => model.runId === runId && model.sequence > sequence)
      .sort((a, b) => a.sequence - b.sequence)
      .map((model) => modelToEnvelope(model));
  }

  /**
   * Registers an in-process live listener for a run's subsequent events.
   *
   * @param {string} runId - Run to subscribe to.
   * @param listener - Callback invoked for each appended event.
   * @return {function(): void} Unsubscribe function that removes the listener.
   */
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

  /**
   * Drops the run's live listeners and deletes all of its persisted event
   * rows.
   *
   * @param {string} runId - Run whose listeners and event rows to release.
   * @param args - Optional decaf `Context` arguments forwarded to the repository.
   * @return {Promise<void>} Resolves once listeners are dropped and rows deleted.
   */
  async release(
    runId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    this.listeners.delete(runId);
    const models = (await this.repo.select().execute(
      ...args
    )) as GraphRunEventModel[];
    for (const model of models) {
      if (model.runId === runId) {
        await this.repo.delete(model.id, ...args);
      }
    }
  }

  private async enforceRetention(runId: string): Promise<void> {
    const max = this.limits.maxEventsPerRun;
    const models = (await this.repo.select().execute()) as GraphRunEventModel[];
    const runModels = models
      .filter((model) => model.runId === runId)
      .sort((a, b) => a.sequence - b.sequence);
    while (runModels.length > max) {
      const evictIndex = runModels.findIndex(
        (model) =>
          !isGraphRunTerminalEventType(
            model.type as GraphExecutionEventType
          )
      );
      if (evictIndex === -1) break;
      const [evicted] = runModels.splice(evictIndex, 1);
      await this.repo.delete(evicted.id);
    }
  }
}
