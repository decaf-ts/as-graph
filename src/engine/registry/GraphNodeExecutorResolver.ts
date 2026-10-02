/**
 * @module as-graph/registry/GraphNodeExecutorResolver
 * @summary Utility for resolving executors from a registry with fallback.
 * @description Provides a helper that attempts to resolve an executor by kind, falling back to a default executor when the kind is not registered.
 *
 * The resolver logs through the synchronous `logCtx` path and therefore
 * requires its callers to provide exactly one Decaf `Context`
 * (`ContextualArgs<Context>`); it never becomes async for logging's sake.
 */
import {
  Service,
  service,
  type Context,
  type ContextualArgs,
} from "@decaf-ts/core";
import type { GraphNodeExecutor } from "../execution/GraphNodeExecutor";
import type { GraphNodeExecutorRegistry } from "./GraphNodeExecutorRegistry";

/**
 * Resolver that wraps a {@link GraphNodeExecutorRegistry} and optionally
 * falls back to a default executor when a kind is not found.
 */
@service()
export class GraphNodeExecutorResolver extends Service {
  private readonly defaultExecutor?: GraphNodeExecutor;

  constructor(
    private readonly registry: GraphNodeExecutorRegistry,
    defaultExecutor?: GraphNodeExecutor
  ) {
    super();
    this.defaultExecutor = defaultExecutor;
  }

  /**
   * Resolves the executor for `kind`, falling back to the default executor
   * when provided.
   */
  resolve(kind: string, ...args: ContextualArgs<Context>): GraphNodeExecutor {
    const { log } = this.logCtx(args, "resolve").for(this.resolve);
    log.debug(`Resolving graph executor for kind '${kind}'`);
    if (this.registry.has(kind, ...args)) {
      return this.registry.resolve(kind, ...args);
    }
    if (this.defaultExecutor) return this.defaultExecutor;
    return this.registry.resolve(kind, ...args);
  }
}
