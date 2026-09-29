/**
 * @module as-graph/store/GraphValueStoreAdapter
 * @summary Adapter interface for persistent graph value storage.
 * @description Users provide implementations of this interface to control where cached/pinned values live (in-memory, database, Redis, file, etc.).
 */
import type { GraphExecutionValues } from "../types";
import type { GraphValueKey } from "./GraphValueKey";
import type { GraphCachedValue } from "./GraphCachedValue";

/**
 * Adapter that persists cached and pinned graph values.
 *
 * The engine never assumes a specific storage backend; it always delegates to
 * an adapter. The {@link InMemoryGraphValueStoreAdapter} is the default.
 */
export interface GraphValueStoreAdapter {
  /** Reads a cached value for the given key. */
  read(key: GraphValueKey): Promise<GraphCachedValue | undefined>;

  /** Writes a cached value for the given key. */
  write(key: GraphValueKey, value: GraphCachedValue): Promise<void>;

  /** Deletes a cached value for the given key. */
  delete(key: GraphValueKey): Promise<void>;

  /** Returns whether a cached value exists for the given key. */
  has(key: GraphValueKey): Promise<boolean>;

  /** Lists cached values matching a prefix of the key. */
  list?(prefix: Partial<GraphValueKey>): Promise<GraphCachedValue[]>;

  /** Clears all cached values for a run. */
  clearRun?(runId: string): Promise<void>;

  /** Reads the runtime values for a node in a run. */
  readRuntimeValues?(
    runId: string,
    nodeId: string
  ): Promise<GraphExecutionValues | undefined>;

  /** Writes the runtime values for a node in a run. */
  writeRuntimeValues?(
    runId: string,
    nodeId: string,
    values: GraphExecutionValues
  ): Promise<void>;
}
