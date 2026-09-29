/**
 * @module as-graph/store/GraphCachedValue
 * @summary A cached graph value with pinning metadata.
 * @description Represents a node's output that has been cached (and optionally pinned) in the value store.
 */
import type { GraphExecutionValues } from "../types";
import type { GraphValueKey } from "./GraphValueKey";

/**
 * A value stored in the cache, including the outputs, pinning state, and
 * timestamps for TTL-based expiry.
 */
export interface GraphCachedValue {
  key: GraphValueKey;
  outputs: GraphExecutionValues;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}
