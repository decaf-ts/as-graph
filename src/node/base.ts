/**
 * @module as-graph/nodes/base
 * @summary Base class for backend graph node declarations.
 * @description `GraphNode` is the single authoritative backend representation of
 * a built-in node kind (DECAF-50 §4.26 R2-1): the `@node`-decorated class
 * carries both the published manifest metadata and the executable behaviour via
 * the **instance** `execute` method. The catalogue derives each kind's executor
 * from the class, so there is exactly one authority per node kind.
 *
 * `execute` is an instance method by CTO ruling: node behaviour configuration
 * lives on the instance (decorated properties, config hydrated from the workflow
 * document), so a node reads its own state through `this` instead of hardcoded
 * workflow values. The only class-level helper kept is `applyMetadata`, which is
 * genuinely stateless (it reads the class's own metadata).
 */
import { Model } from "@decaf-ts/decorator-validation";
import type { GraphNodeInstance, NodeMetadataChange } from "../shared/graph";
import type { GraphExecutionContext } from "../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../engine/types";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";

/**
 * Flattens a canonical {@link GraphNodeInstance} into the configuration object a
 * node class hydrates from.
 *
 * The node's own `metadata` supplies defaults first and the executing
 * `parameters` override them (matching the pre-existing built-in registration
 * hydration order), with the persisted user-defined `state` overriding both and the
 * loop configuration appended when present. The state is applied last so a
 * `@state()` value always wins over a same-named parameter, and `execute` reads
 * it via `this.*` unchanged. The resulting object is what {@link GraphNode}'s
 * constructor feeds to `Model.fromModel`.
 *
 * @param instance - The canonical node instance from the workflow document.
 * @returns The flattened node configuration, or `undefined` when there is none.
 */
export function graphNodeConfig(
  instance?: GraphNodeInstance
): Record<string, unknown> | undefined {
  if (!instance) return undefined;
  const config: Record<string, unknown> = {
    ...((instance.metadata as Record<string, unknown>) ?? {}),
    ...((instance.parameters as Record<string, unknown>) ?? {}),
    ...((instance.state as Record<string, unknown>) ?? {}),
  };
  if (instance.loop) config["loop"] = instance.loop;
  return config;
}

/**
 * Constructor shape of a built-in backend node class.
 *
 * Nodes are instantiated by the built-in registration before execution so their
 * instance `execute` method can run against hydrated instance state. `INPUT`
 * defaults to `unknown` and `OUTPUT` defaults to `INPUT` (DECAF-50 §4.26), so a
 * node that does not transform its payload declares only one type argument and
 * boundary nodes use `void` on the appropriate side.
 */
export interface GraphNodeClass<INPUT = unknown, OUTPUT = INPUT> {
  /** Node kind discriminator declared via the `@node` decorator. */
  readonly kind?: string;
  /**
   * Creates a fresh node instance for execution, hydrating its decorated
   * configuration properties from `config`.
   */
  instantiate(config?: Record<string, unknown>): GraphNode<INPUT, OUTPUT>;
}

/**
 * Base class for the built-in backend node kinds.
 *
 * Extends `Model` so the `@node`/`@uielement` decorators and the manifest
 * compiler keep working unchanged. Concrete kinds override the instance `execute`
 * method; the default throws so a kind that forgets to implement behaviour fails
 * fast rather than silently producing no output.
 *
 * @typeParam INPUT - The shape of the node's input values (`void` for input
 *   boundary nodes, which receive no upstream data).
 * @typeParam OUTPUT - The shape of the node's output values (`void` for output
 *   boundary nodes, which terminate the stream). Defaults to `INPUT`.
 */
export abstract class GraphNode<
  INPUT = unknown,
  OUTPUT = INPUT,
> extends Model {
  /**
   * Hydrates the node instance from its flattened configuration.
   *
   * Every concrete node class is `@model()`-decorated, so the global model
   * builder already runs `Model.fromModel` on construction. Declaring the
   * constructor on the base class makes that contract explicit and uniform for
   * **all** node kinds: a node's decorated configuration properties
   * (`@input`/`@uielement`/`@prop`) are populated from `arg`, so `execute` can
   * read `this.*` without a separate hydration step.
   *
   * @param arg - The flattened node configuration (see
   *   {@link graphNodeConfig}).
   */
  protected constructor(arg?: Record<string, unknown>) {
    super();
    Model.fromModel(this, arg);
  }

  /**
   * Phantom marker tying the `OUTPUT` type parameter to the class (it has no
   * runtime footprint; `execute` returns the generic value map).
   */
  declare protected readonly graphNodeOutput?: OUTPUT;

  /**
   * Executes the node's behaviour against the request inputs and run context.
   *
   * This is an instance method so a node can read its own hydrated configuration
   * (`this.*`) rather than hardcoded workflow values.
   *
   * @param _request - The node execution request (inputs, parameters,
   * credentials, metadata).
   * @param _context - The run-scoped execution context.
   * @returns The node's output values keyed by port name.
   * @throws {GraphExecutionError} when the kind does not implement `execute`.
   */
  execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphNodeExecutionRequest<INPUT>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context: GraphExecutionContext
  ): GraphExecutionValues | Promise<GraphExecutionValues> {
    throw new GraphExecutionError(
      `Graph node kind '${this.constructor.name}' does not implement execute`,
      "GRAPH_NODE_EXECUTE_NOT_IMPLEMENTED",
      { kind: this.constructor.name }
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
   * Kept `static` by CTO ruling: unlike `execute`, this helper is genuinely
   * stateless — it operates purely on the class's own metadata and carries no
   * per-execution instance state.
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

  /**
   * Creates a fresh instance of the concrete node class.
   *
   * Node classes may declare a protected constructor (the `@model()`
   * decorator narrows it), so callers cannot use `new NodeClass()` directly.
   * This inherited static factory performs the instantiation from inside the
   * class, where the constructor is accessible.
   *
   * @param config - The flattened node configuration to hydrate from.
   * @returns A new instance of the concrete node class.
   */
  static instantiate(config?: Record<string, unknown>): GraphNode {
    return new (
      this as unknown as { new (config?: Record<string, unknown>): GraphNode }
    )(config);
  }
}
