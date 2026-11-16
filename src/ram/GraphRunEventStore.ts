/**
 * @module as-graph/ram/GraphRunEventStore
 * @summary Adapter-backed graph run event store (DECAF-50 §4.14–§4.16).
 * @description Repository-backed {@link GraphRunEventStore}: envelopes are
 * persisted as {@link GraphRunEventModel} rows through a provided Decaf adapter.
 * Live subscribers are kept in-process (a listener cannot be serialized); replay
 * reads come from the adapter. Retention uses {@link GraphRunLimits}.
 */
import {
  Condition,
  OrderDirection,
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

/** Rows deleted per batch. */
const DELETE_BATCH = 500;
/** Rows read per page (the Postgres adapter caps unbounded selects at 250). */
const PAGE = 1000;

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
   * Appends an event envelope and notifies in-process subscribers. The
   * per-run cap is enforced only once the gapless sequence crosses it, with
   * one indexed delete (never a scan of other runs' events).
   *
   * @param {GraphRunEventEnvelope} event - Envelope to persist and broadcast.
   * @return {Promise<void>} Resolves once the row is persisted and the cap applied.
   */
  async append(event: GraphRunEventEnvelope): Promise<void> {
    await this.repo.create(envelopeToModel(event));
    if (event.sequence > this.limits.maxEventsPerRun) {
      await this.evictBefore(
        event.runId,
        event.sequence - this.limits.maxEventsPerRun
      );
    }
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
   * one, in ascending order — one indexed query on `(runId, sequence)`.
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
    // Keyset pages on the gapless sequence (the adapter caps unbounded
    // selects).
    const envelopes: GraphRunEventEnvelope[] = [];
    let after = sequence;
    for (;;) {
      const models = (await this.repo
        .select()
        .where(
          Condition.attr<GraphRunEventModel>("runId")
            .eq(runId)
            .and(Condition.attr<GraphRunEventModel>("sequence").gt(after))
        )
        .orderBy("sequence", OrderDirection.ASC)
        .limit(PAGE)
        .execute(...args)) as GraphRunEventModel[];
      envelopes.push(...models.map((model) => modelToEnvelope(model)));
      if (models.length < PAGE) return envelopes;
      after = models[models.length - 1].sequence;
    }
  }

  /**
   * The highest stored sequence of a run, or `0` when it has none. Lets a
   * process that did not run the workflow (recovery, another worker) continue
   * its gapless sequence.
   *
   * @param {string} runId - The run.
   * @return {Promise<number>} The last sequence.
   */
  async lastSequence(
    runId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<number> {
    const models = (await this.repo
      .select()
      .where(Condition.attr<GraphRunEventModel>("runId").eq(runId))
      .orderBy("sequence", OrderDirection.DSC)
      .limit(1)
      .execute(...args)) as GraphRunEventModel[];
    return models[0]?.sequence ?? 0;
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
   * Drops the run's live listeners and deletes its event rows (one indexed
   * query, batched deletes).
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
    for (let round = 0; round < 10_000; round++) {
      const models = (await this.repo
        .select(["id"] as never)
        .where(Condition.attr<GraphRunEventModel>("runId").eq(runId))
        .limit(PAGE)
        .execute(...args)) as GraphRunEventModel[];
      await this.deleteIds(models.map((model) => model.id), ...args);
      if (models.length < PAGE) return;
    }
  }

  /** Deletes a run's non-terminal events with a sequence at or below `cutoff`. */
  private async evictBefore(runId: string, cutoff: number): Promise<void> {
    const models = (await this.repo
      .select()
      .where(
        Condition.attr<GraphRunEventModel>("runId")
          .eq(runId)
          .and(Condition.attr<GraphRunEventModel>("sequence").lte(cutoff))
      )
      .limit(PAGE * 20)
      .execute()) as GraphRunEventModel[];
    await this.deleteIds(
      models
        .filter(
          (model) =>
            !isGraphRunTerminalEventType(model.type as GraphExecutionEventType)
        )
        .map((model) => model.id)
    );
  }

  /** Deletes rows by id in batches; rows already gone are not an error. */
  private async deleteIds(
    ids: string[],
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    for (let index = 0; index < ids.length; index += DELETE_BATCH) {
      const batch = ids.slice(index, index + DELETE_BATCH);
      try {
        await this.repo.deleteAll(batch, ...args);
      } catch {
        for (const id of batch) {
          try {
            await this.repo.delete(id, ...args);
          } catch {
            // a row a concurrent release already deleted is not an error
          }
        }
      }
    }
  }
}
