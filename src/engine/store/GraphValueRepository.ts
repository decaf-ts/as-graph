/**
 * @module as-graph/store/GraphValueRepository
 * @summary Repository for cached/pinned graph values (DECAF-50 §4.9).
 * @description Replaces the former `GraphValueStore` adapter wrapper. Cached and
 * pinned values are {@link GraphValueModel} rows persisted through the
 * configured Decaf adapter/repository; the per-run runtime values (workflow
 * inputs, node outputs, workflow outputs for the current execution) are
 * explicitly NOT persisted in production and therefore stay in an in-process map
 * on this repository.
 */
import {
  Repository,
  repository,
  type Adapter,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import { DefaultFlavour } from "@decaf-ts/decoration";
import { GRAPH_WORKFLOW_BOUNDARY } from "../constants";
import type { GraphExecutionValues } from "../types";
import type { GraphValueKey } from "./GraphValueKey";
import type { GraphCachedValue } from "./GraphCachedValue";
import { GraphValueModel } from "./GraphValueModel";

/**
 * Serializes a value key into the stable string used as the persisted primary
 * key, matching the runtime addressing of cached values.
 */
export function serializeGraphValueKey(key: GraphValueKey): string {
  return [
    key.namespace ?? "default",
    key.workflowId,
    key.nodeId,
    key.version ?? "default",
    key.fingerprint,
  ].join(":");
}

function toModel(value: GraphCachedValue): GraphValueModel {
  return new GraphValueModel({
    id: serializeGraphValueKey(value.key),
    workflowId: value.key.workflowId,
    nodeId: value.key.nodeId,
    fingerprint: value.key.fingerprint,
    ...(value.key.namespace !== undefined
      ? { namespace: value.key.namespace }
      : {}),
    ...(value.key.version !== undefined ? { version: value.key.version } : {}),
    pinned: value.pinned,
    outputs: value.outputs as Record<string, unknown>,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
    ...(value.expiresAt ? { expiresAt: new Date(value.expiresAt) } : {}),
    ...(value.metadata ? { metadata: value.metadata } : {}),
  });
}

function toCached(model: GraphValueModel): GraphCachedValue {
  const key: GraphValueKey = {
    workflowId: model.workflowId,
    nodeId: model.nodeId,
    fingerprint: model.fingerprint,
    ...(model.namespace !== undefined ? { namespace: model.namespace } : {}),
    ...(model.version !== undefined ? { version: model.version } : {}),
  };
  return {
    key,
    outputs: model.outputs as GraphExecutionValues,
    pinned: model.pinned,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
    ...(model.expiresAt ? { expiresAt: model.expiresAt.toISOString() } : {}),
    ...(model.metadata ? { metadata: model.metadata } : {}),
  };
}

/**
 * Adapter-backed repository managing cached/pinned graph values as
 * {@link GraphValueModel} rows, plus the ephemeral runtime values for the
 * current execution.
 *
 * Persisted cached/pinned values go through the Decaf repository/adapter APIs
 * (`create`/`read`/`update`/`delete`/`select`). Runtime values are held in a
 * per-execution in-process map and are documented as not persisted in
 * production: they exist only for the duration of a single run.
 */
@repository(GraphValueModel, DefaultFlavour)
export class GraphValueRepository extends Repository<
  GraphValueModel,
  Adapter<any, any, any, any>
> {
  private readonly runtimeValues = new Map<string, GraphExecutionValues>();

  /**
   * @param adapter - The Decaf adapter backing cached/pinned value persistence.
   *   A fresh repository instance is created per execution (sharing the adapter)
   *   so runtime values stay isolated; `force` allows re-registration.
   */
  constructor(adapter?: Adapter<any, any, any, any>) {
    super(adapter, GraphValueModel, true);
  }

  /** Seeds the workflow input values for the current execution. */
  seedWorkflowInputs(inputs: GraphExecutionValues): void {
    this.runtimeValues.set(GRAPH_WORKFLOW_BOUNDARY, { ...inputs });
  }

  /** Stores the outputs produced by a node for the current execution. */
  setNodeOutputs(nodeId: string, outputs: GraphExecutionValues): void {
    this.runtimeValues.set(nodeId, { ...outputs });
  }

  /** Reads a single port value from a node's runtime outputs. */
  getPort(nodeId: string, port: string): unknown {
    return this.runtimeValues.get(nodeId)?.[port];
  }

  /** Returns whether a node has a runtime value for the given port. */
  hasPort(nodeId: string, port: string): boolean {
    return Object.prototype.hasOwnProperty.call(
      this.runtimeValues.get(nodeId) ?? {},
      port
    );
  }

  /** Sets a single workflow output port value for the current execution. */
  setWorkflowOutput(port: string, value: unknown): void {
    const current = this.runtimeValues.get(GRAPH_WORKFLOW_BOUNDARY) ?? {};
    current[port] = value;
    this.runtimeValues.set(GRAPH_WORKFLOW_BOUNDARY, current);
  }

  /** Returns all workflow-level values (inputs merged with outputs). */
  getWorkflowValues(): GraphExecutionValues {
    return {
      ...(this.runtimeValues.get(GRAPH_WORKFLOW_BOUNDARY) ?? {}),
    };
  }

  /** Returns a snapshot of all runtime values for the current execution. */
  snapshot(): Record<string, GraphExecutionValues> {
    return Object.fromEntries(this.runtimeValues.entries());
  }

  /** Reads a cached value through the repository/adapter APIs. */
  async readCached(
    key: GraphValueKey,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphCachedValue | undefined> {
    try {
      const model = await this.read(serializeGraphValueKey(key), ...args);
      return toCached(model as GraphValueModel);
    } catch {
      return undefined;
    }
  }

  /** Writes (creates or updates) a cached value through the repository APIs. */
  async writeCached(
    key: GraphValueKey,
    value: GraphCachedValue,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    const id = serializeGraphValueKey(key);
    let existing: GraphValueModel | undefined;
    try {
      existing = (await this.read(id, ...args)) as GraphValueModel;
    } catch {
      existing = undefined;
    }
    if (existing) {
      await this.update(Object.assign(existing, toModel(value)), ...args);
      return;
    }
    await this.create(toModel(value), ...args);
  }

  /** Deletes a cached value through the repository/adapter APIs. */
  async deleteCached(
    key: GraphValueKey,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    try {
      await this.delete(serializeGraphValueKey(key), ...args);
    } catch {
      // deleting a missing cached value is a no-op
    }
  }

  /** Returns whether a cached value exists. */
  async hasCached(
    key: GraphValueKey,
    ...args: MaybeContextualArg<Context>
  ): Promise<boolean> {
    return (await this.readCached(key, ...args)) !== undefined;
  }

  /** Lists cached values matching a prefix of the key. */
  async listCached(
    prefix: Partial<GraphValueKey>,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphCachedValue[]> {
    const models = (await this.select().execute(...args)) as GraphValueModel[];
    return models
      .map((model) => toCached(model))
      .filter((value) => matchesPrefix(value.key, prefix));
  }

  /**
   * Clears every cached value for a run. `runId` is retained for call-site
   * compatibility; cached values are keyed by workflow/node/fingerprint rather
   * than by run, so this clears the repository's cached rows.
   */
  async clearRun(
    runId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    void runId;
    const models = (await this.select().execute(...args)) as GraphValueModel[];
    for (const model of models) {
      await this.delete(model.id, ...args);
    }
  }

  /** Reads runtime values for a node in the current execution. */
  readRuntimeValues(nodeId: string): GraphExecutionValues | undefined {
    return this.runtimeValues.get(nodeId);
  }

  /** Writes runtime values for a node in the current execution. */
  writeRuntimeValues(nodeId: string, values: GraphExecutionValues): void {
    this.runtimeValues.set(nodeId, { ...values });
  }

  /** Returns the underlying adapter. */
  getAdapter(): Adapter<any, any, any, any> {
    return this.adapter;
  }
}

/**
 * Creates a fresh {@link GraphValueRepository} bound to the provided adapter.
 *
 * The class-level `@repository(GraphValueModel)` decoration registers the
 * repository for the model and replaces its constructor with the injectable factory,
 * so a direct `new GraphValueRepository(adapter)` no longer forwards the adapter.
 * This factory resolves the registered constructor and instantiates it directly,
 * guaranteeing a per-execution instance that shares the provided adapter while
 * keeping its runtime values isolated from other executions.
 *
 * @param adapter - The Decaf adapter backing cached/pinned value persistence.
 * @returns A fresh repository instance bound to the adapter.
 */
export function createGraphValueRepository(
  adapter: Adapter<any, any, any, any>
): GraphValueRepository {
  const Registered = Repository.forModel(GraphValueModel, adapter.alias)
    .constructor as new (
    adapter: Adapter<any, any, any, any>
  ) => GraphValueRepository;
  return new Registered(adapter);
}

function matchesPrefix(
  key: GraphValueKey,
  prefix: Partial<GraphValueKey>
): boolean {
  if (prefix.workflowId !== undefined && key.workflowId !== prefix.workflowId)
    return false;
  if (prefix.nodeId !== undefined && key.nodeId !== prefix.nodeId) return false;
  if (prefix.namespace !== undefined && key.namespace !== prefix.namespace)
    return false;
  if (prefix.version !== undefined && key.version !== prefix.version)
    return false;
  if (
    prefix.fingerprint !== undefined &&
    key.fingerprint !== prefix.fingerprint
  )
    return false;
  return true;
}
