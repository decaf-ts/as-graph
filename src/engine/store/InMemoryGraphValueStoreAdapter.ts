/**
 * @module as-graph/store/InMemoryGraphValueStoreAdapter
 * @summary Default in-memory value store adapter.
 * @description Stores all cached values in a Map. Suitable for testing and single-process execution.
 */
import type { GraphValueStoreAdapter } from "./GraphValueStoreAdapter";
import type { GraphValueKey } from "./GraphValueKey";
import type { GraphCachedValue } from "./GraphCachedValue";

/**
 * In-memory implementation of {@link GraphValueStoreAdapter}.
 *
 * Values are keyed by a serialized string combining namespace, workflowId,
 * nodeId, version, and fingerprint.
 */
export class InMemoryGraphValueStoreAdapter implements GraphValueStoreAdapter {
  private readonly values = new Map<string, GraphCachedValue>();

  /** @inheritDoc */
  async read(key: GraphValueKey): Promise<GraphCachedValue | undefined> {
    return this.values.get(this.serializeKey(key));
  }

  /** @inheritDoc */
  async write(key: GraphValueKey, value: GraphCachedValue): Promise<void> {
    this.values.set(this.serializeKey(key), value);
  }

  /** @inheritDoc */
  async delete(key: GraphValueKey): Promise<void> {
    this.values.delete(this.serializeKey(key));
  }

  /** @inheritDoc */
  async has(key: GraphValueKey): Promise<boolean> {
    return this.values.has(this.serializeKey(key));
  }

  /** @inheritDoc */
  async list(prefix: Partial<GraphValueKey>): Promise<GraphCachedValue[]> {
    const results: GraphCachedValue[] = [];
    for (const value of this.values.values()) {
      const k = value.key;
      if (
        prefix.workflowId !== undefined &&
        k.workflowId !== prefix.workflowId
      )
        continue;
      if (prefix.nodeId !== undefined && k.nodeId !== prefix.nodeId) continue;
      if (
        prefix.namespace !== undefined &&
        k.namespace !== prefix.namespace
      )
        continue;
      if (prefix.version !== undefined && k.version !== prefix.version)
        continue;
      results.push(value);
    }
    return results;
  }

  /** @inheritDoc */
  async clearRun(runId: string): Promise<void> {
    void runId;
    this.values.clear();
  }

  /**
   * Serializes a key into a stable string used as the Map key.
   */
  private serializeKey(key: GraphValueKey): string {
    return [
      key.namespace ?? "default",
      key.workflowId,
      key.nodeId,
      key.version ?? "default",
      key.fingerprint,
    ].join(":");
  }
}
