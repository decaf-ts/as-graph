/**
 * @module as-graph/store/GraphValueKey
 * @summary Stable key for cached graph values.
 * @description Identifies a cached value in the store by workflow, node, fingerprint, and optional namespace/version.
 */

/**
 * Key used to read/write cached values in a {@link GraphValueStoreAdapter}.
 *
 * The `fingerprint` must change when meaningful inputs or dependencies change
 * so stale values are never accidentally reused.
 */
export interface GraphValueKey {
  workflowId: string;
  nodeId: string;
  fingerprint: string;
  namespace?: string;
  version?: string;
}
