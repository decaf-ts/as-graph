/**
 * @module as-graph/nodes/base
 * @summary Base class for backend graph node declarations.
 * @description `GraphNode` is the single authoritative backend representation of
 * a built-in node kind (DECAF-50 §4.26 R2-1): the `@node`-decorated class
 * carries both the published manifest metadata and the executable behaviour via
 * `execute`. The catalogue derives each kind's executor from the class, so there
 * is exactly one authority per node kind.
 */
import { Model } from "@decaf-ts/decorator-validation";
import type { NodeMetadataChange } from "../shared/graph";
import type { GraphExecutionContext } from "../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../engine/types";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";

/**
 * Constructor shape of a built-in backend node class: a `Model` subclass whose
 * static `execute` performs the node's work.
 */
export interface GraphNodeClass {
  /** Node kind discriminator declared via the `@node` decorator. */
  readonly kind?: string;
  /** The node's executable behaviour. */
  execute(
    request: GraphNodeExecutionRequest,
    context: GraphExecutionContext
  ): GraphExecutionValues | Promise<GraphExecutionValues>;
}

/**
 * Base class for the built-in backend node kinds.
 *
 * Extends `Model` so the `@node`/`@uielement` decorators and the manifest
 * compiler keep working unchanged. Concrete kinds override `execute`; the default
 * throws so a kind that forgets to implement behaviour fails fast rather than
 * silently producing no output.
 */
export class GraphNode extends Model {
  /**
   * Executes the node's behaviour against the request inputs and run context.
   *
   * @param _request - The node execution request (inputs, parameters,
   * credentials, metadata).
   * @param _context - The run-scoped execution context.
   * @returns The node's output values keyed by port name.
   * @throws {GraphExecutionError} when the kind does not implement `execute`.
   */

  static execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphNodeExecutionRequest,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: GraphExecutionContext
  ): GraphExecutionValues | Promise<GraphExecutionValues> {
    throw new GraphExecutionError(
      `Graph node kind '${this.name}' does not implement execute`,
      "GRAPH_NODE_EXECUTE_NOT_IMPLEMENTED",
      { kind: this.name }
    );
  }

  /**
   * Applies a metadata patch to this node class, returning the resulting
   * ports, size, and data patches.
   *
   * The default implementation returns `null` (no changes). Concrete node
   * kinds that support dynamic metadata override this to compute their own
   * ports and size from the metadata — the caller (renderer) simply relays
   * the result to the diagram model.
   *
   * @param _meta - The metadata patch (node-kind-specific, e.g.
   *   `SwitchNodeMetadata`).
   * @returns The computed change, or `null` when the node kind does not
   *   support dynamic metadata.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static applyMetadata(_meta: unknown): NodeMetadataChange | null {
    return null;
  }
}
