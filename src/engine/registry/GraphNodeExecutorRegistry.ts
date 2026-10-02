/**
 * @module as-graph/registry/GraphNodeExecutorRegistry
 * @summary Compatibility facade over {@link GraphNodeCatalogue} (DECAF-50 §4.7).
 * @description Holds no map of its own: every kind→executor binding lives in
 * the catalogue's single kind→registration map. `register()` upserts the
 * executor on an existing registration or creates a placeholder-manifest entry
 * for legacy executor-only registrations; the strict manifest+executor pairing
 * required by DECAF-50 is enforced by `GraphNodeCatalogue.register()`.
 *
 * Legacy error contract preserved: this facade keeps throwing
 * {@link GraphExecutionError} where the pre-catalogue registry did, while the
 * underlying catalogue throws the normative DECAF-50 catalogue errors.
 *
 * The facade logs through the synchronous `logCtx` path and therefore requires
 * its callers to provide exactly one Decaf `Context` (`ContextualArgs<Context>`);
 * it never becomes async for logging's sake.
 */
import {
  Service,
  service,
  type Context,
  type ContextualArgs,
} from "@decaf-ts/core";
import type { GraphNodeExecutor } from "../execution/GraphNodeExecutor";
import { GraphNodeCatalogue } from "../catalog/GraphNodeCatalogue";
import { GraphNodeNotFoundError } from "../catalog/GraphCatalogueErrors";
import { GraphExecutionError } from "../errors/GraphExecutionError";

/**
 * Compatibility facade over {@link GraphNodeCatalogue} for legacy
 * kind→executor registration (DECAF-50 §4.7). Delegates every binding to the
 * catalogue and preserves the pre-catalogue {@link GraphExecutionError}
 * contract.
 */
@service()
export class GraphNodeExecutorRegistry extends Service {
  constructor(
    private readonly catalogue: GraphNodeCatalogue = new GraphNodeCatalogue()
  ) {
    super();
  }

  /** The backing catalogue holding all kind→registration entries. */
  get catalog(): GraphNodeCatalogue {
    return this.catalogue;
  }

  /** Registers an executor for the given node kind. */
  register(
    kind: string,
    executor: GraphNodeExecutor,
    ...args: ContextualArgs<Context>
  ): this {
    const { log } = this.logCtx(args, "register").for(this.register);
    log.debug(`Registering graph executor for kind '${kind}'`);
    if (!kind) {
      throw new GraphExecutionError("Graph executor kind is required");
    }
    this.catalogue.registerExecutor(kind, executor, ...args);
    return this;
  }

  /** Removes the registration for the given node kind. */
  unregister(kind: string, ...args: ContextualArgs<Context>): this {
    const { log } = this.logCtx(args, "unregister").for(this.unregister);
    log.debug(`Unregistering graph executor for kind '${kind}'`);
    this.catalogue.unregister(kind, ...args);
    return this;
  }

  /** Returns whether a registration exists for the given kind. */
  has(kind: string, ...args: ContextualArgs<Context>): boolean {
    this.logCtx(args, "has").for(this.has);
    return this.catalogue.has(kind, ...args);
  }

  /**
   * Resolves the executor for the given node kind.
   *
   * @throws {GraphExecutionError} when no registration exists for `kind`.
   */
  resolve(kind: string, ...args: ContextualArgs<Context>): GraphNodeExecutor {
    this.logCtx(args, "resolve").for(this.resolve);
    try {
      return this.catalogue.getExecutor(kind, ...args);
    } catch (e) {
      if (e instanceof GraphNodeNotFoundError) {
        throw new GraphExecutionError(
          `No graph executor registered for kind '${kind}'`,
          "GRAPH_EXECUTOR_NOT_FOUND",
          { kind }
        );
      }
      throw e;
    }
  }
}
