/**
 * @module as-graph/store/GraphValueStore
 * @summary Runtime value store wrapping a persistent adapter.
 * @description Holds runtime values for the current execution in memory and delegates cached/pinned values to a {@link GraphValueStoreAdapter}.
 */
import { GRAPH_WORKFLOW_BOUNDARY } from "../constants";
import type { GraphExecutionValues } from "../types";
import type { GraphValueStoreAdapter } from "./GraphValueStoreAdapter";
import type { GraphValueKey } from "./GraphValueKey";
import type { GraphCachedValue } from "./GraphCachedValue";

/**
 * Manages values during a single graph execution.
 *
 * Runtime values (workflow inputs, node outputs, workflow outputs) are kept in
 * an in-memory map. Persistent cache and pinning operations are delegated to
 * the configured {@link GraphValueStoreAdapter}.
 */
export class GraphValueStore {
  private readonly runtimeValues = new Map<string, GraphExecutionValues>();

  /**
   * @param adapter - The persistent adapter for cached/pinned values.
   */
  constructor(private readonly adapter: GraphValueStoreAdapter) {}

  /** Seeds the workflow input values. */
  seedWorkflowInputs(inputs: GraphExecutionValues): void {
    this.runtimeValues.set(GRAPH_WORKFLOW_BOUNDARY, { ...inputs });
  }

  /** Stores the outputs produced by a node. */
  setNodeOutputs(nodeId: string, outputs: GraphExecutionValues): void {
    this.runtimeValues.set(nodeId, { ...outputs });
  }

  /** Reads a single port value from a node's stored outputs. */
  getPort(nodeId: string, port: string): unknown {
    return this.runtimeValues.get(nodeId)?.[port];
  }

  /** Returns whether a node has a value for the given port. */
  hasPort(nodeId: string, port: string): boolean {
    return Object.prototype.hasOwnProperty.call(
      this.runtimeValues.get(nodeId) ?? {},
      port
    );
  }

  /** Sets a single workflow output port value. */
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

  /** Reads a cached value from the adapter. */
  async readCached(key: GraphValueKey): Promise<GraphCachedValue | undefined> {
    return this.adapter.read(key);
  }

  /** Writes a cached value through the adapter. */
  async writeCached(key: GraphValueKey, value: GraphCachedValue): Promise<void> {
    await this.adapter.write(key, value);
  }

  /** Deletes a cached value through the adapter. */
  async deleteCached(key: GraphValueKey): Promise<void> {
    await this.adapter.delete(key);
  }

  /** Returns a snapshot of all runtime values. */
  snapshot(): Record<string, GraphExecutionValues> {
    return Object.fromEntries(this.runtimeValues.entries());
  }

  /** Returns the underlying adapter (used by the pinning service). */
  getAdapter(): GraphValueStoreAdapter {
    return this.adapter;
  }
}
