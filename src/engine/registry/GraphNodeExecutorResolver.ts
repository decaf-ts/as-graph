/**
 * @module as-graph/registry/GraphNodeExecutorResolver
 * @summary Utility for resolving executors from a registry with fallback.
 * @description Provides a helper that attempts to resolve an executor by kind, falling back to a default executor when the kind is not registered.
 */
import type { GraphNodeExecutor } from "../execution/GraphNodeExecutor";
import type { GraphNodeExecutorRegistry } from "./GraphNodeExecutorRegistry";

/**
 * Resolver that wraps a {@link GraphNodeExecutorRegistry} and optionally
 * falls back to a default executor when a kind is not found.
 */
export class GraphNodeExecutorResolver {
  private readonly defaultExecutor?: GraphNodeExecutor;

  constructor(
    private readonly registry: GraphNodeExecutorRegistry,
    defaultExecutor?: GraphNodeExecutor
  ) {
    this.defaultExecutor = defaultExecutor;
  }

  /**
   * Resolves the executor for `kind`, falling back to the default executor
   * when provided.
   */
  resolve(kind: string): GraphNodeExecutor {
    if (this.registry.has(kind)) return this.registry.resolve(kind);
    if (this.defaultExecutor) return this.defaultExecutor;
    return this.registry.resolve(kind);
  }
}
