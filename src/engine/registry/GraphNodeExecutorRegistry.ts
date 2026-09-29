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
 */
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
export class GraphNodeExecutorRegistry {
  constructor(
    private readonly catalogue: GraphNodeCatalogue = new GraphNodeCatalogue()
  ) {}

  /** The backing catalogue holding all kind→registration entries. */
  get catalog(): GraphNodeCatalogue {
    return this.catalogue;
  }

  /** Registers an executor for the given node kind. */
  register(kind: string, executor: GraphNodeExecutor): this {
    if (!kind) {
      throw new GraphExecutionError("Graph executor kind is required");
    }
    this.catalogue.registerExecutor(kind, executor);
    return this;
  }

  /** Removes the registration for the given node kind. */
  unregister(kind: string): this {
    this.catalogue.unregister(kind);
    return this;
  }

  /** Returns whether a registration exists for the given kind. */
  has(kind: string): boolean {
    return this.catalogue.has(kind);
  }

  /**
   * Resolves the executor for the given node kind.
   *
   * @throws {GraphExecutionError} when no registration exists for `kind`.
   */
  resolve(kind: string): GraphNodeExecutor {
    try {
      return this.catalogue.getExecutor(kind);
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
