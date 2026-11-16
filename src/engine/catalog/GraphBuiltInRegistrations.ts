/**
 * @module as-graph/engine/catalog/GraphBuiltInRegistrations
 * @summary Built-in graph node registrations (DECAF-50 §4.12, §4.26 R2-1).
 * @description Derives every built-in {@link GraphNodeRegistration} from its
 * authoritative backend node class: the published manifest comes from
 * `GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND` and the executor instantiates the
 * class, hydrates its configuration from the executing canonical node instance,
 * and invokes the **instance** `execute` method. Because node classes reach the
 * engine through `GraphExecutionContext.engine`, no executor needs an engine
 * back-reference and every built-in kind is registered in a single pass.
 */
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import type { GraphNodeExecutor } from "../execution/GraphNodeExecutor";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import type { GraphExecutionContext } from "../execution/GraphExecutionContext";
import type { GraphNodeExecutionRequest } from "../types";
import { graphNodeConfig, type GraphNodeClass } from "../../node/base";
import {
  GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND,
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
} from "../../node";
import { GraphNodeCatalogue } from "./GraphNodeCatalogue";
import {
  defineGraphNode,
  type GraphNodeRegistration,
} from "./GraphNodeRegistration";

/**
 * Fits a value routed onto a configuration port to the port's declared type.
 *
 * A wired value replaces what the user would have typed into a typed field,
 * so it gets the same treatment a form gives: numeric text becomes a number,
 * `"true"`/`"false"` become booleans, and an option field only accepts one of
 * its options. A value that cannot be read as the port's type fails the node
 * with `GRAPH_INPUT_TYPE_MISMATCH` instead of reaching `execute()` as garbage.
 *
 * @param value - The routed value.
 * @param schema - The port's value schema.
 * @param nodeId - The node receiving the value, for the error.
 * @param portId - The port receiving the value, for the error.
 * @returns The value, coerced when the port type calls for it.
 * @throws {GraphExecutionError} `GRAPH_INPUT_TYPE_MISMATCH` on an unusable value.
 */
export function coerceWiredConfigurationValue(
  value: unknown,
  schema: { type?: string; values?: readonly unknown[] } | undefined,
  nodeId: string,
  portId: string
): unknown {
  const mismatch = (expected: string): never => {
    throw new GraphExecutionError(
      `Node '${nodeId}' received ${
        Array.isArray(value) ? "a list" : `a ${typeof value}`
      } on configuration port '${portId}', which expects ${expected}`,
      "GRAPH_INPUT_TYPE_MISMATCH",
      { nodeId, port: portId, expected }
    );
  };
  if (value === null) return value;
  switch (schema?.type) {
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return mismatch("a number");
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return mismatch("a boolean");
    }
    case "string": {
      // A text field also accepts structured data: several text-typed fields
      // (a body, a content, a record) take a record or a file payload.
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return value;
    }
    case "enum": {
      const options = schema.values ?? [];
      if (options.length === 0 || options.includes(value)) return value;
      return mismatch(`one of ${options.map((entry) => String(entry)).join(", ")}`);
    }
    case "array": {
      if (Array.isArray(value)) return value;
      return mismatch("a list");
    }
    default:
      return value;
  }
}

/**
 * Collects the configuration values that arrived through a node's
 * expose-as-port inputs.
 *
 * A property declared with `@uielement` and `@input({ userControlled: true })`
 * is either filled in the editor (persisted in `parameters`) or exposed as a
 * port and fed by an edge or an input binding. The node reads it through
 * `this.<prop>` in both cases, so a routed value has to reach the instance the
 * same way a filled one does. Only ports the document actually binds are
 * considered: a multi-edge fan-in also spreads values under their source port
 * names, and such a spread value must never be mistaken for a wired
 * configuration port.
 *
 * @param request - The node execution request carrying the routed inputs.
 * @param context - The run-scoped context (manifest, node instance, document).
 * @returns The wired configuration values keyed by property name.
 */
export function wiredGraphNodeConfiguration(
  request: GraphNodeExecutionRequest,
  context: GraphExecutionContext
): Record<string, unknown> {
  const inputs = (request.inputs ?? {}) as Record<string, unknown>;
  const node = context?.node;
  const manifest = context?.manifest;
  if (!node || !manifest) return {};
  const bound = new Set<string>(Object.keys(node.inputBindings ?? {}));
  for (const edge of context.document?.edges ?? []) {
    if (edge.type !== "data") continue;
    if (edge.target.scope !== "node" || edge.target.nodeId !== node.id) continue;
    bound.add(edge.target.port);
  }
  const wired: Record<string, unknown> = {};
  for (const port of manifest.inputs ?? []) {
    if (port.configurable !== true || !bound.has(port.id)) continue;
    const value = inputs[port.id];
    if (value !== undefined) {
      wired[port.id] = coerceWiredConfigurationValue(
        value,
        port.schema,
        node.id,
        port.id
      );
    }
  }
  return wired;
}

/**
 * Builds the executor of a built-in node class.
 *
 * The executor is the single way a node class is run: it instantiates the
 * class, hydrates it from the canonical instance, the resolved parameters and
 * any wired configuration ports, and calls the instance `execute`. Every
 * execution backend that runs engine-neutral kinds goes through it, so a node
 * behaves the same on each engine.
 *
 * @param nodeClass - The `@node`-decorated class.
 * @returns The executor wrapping the class.
 */
export function builtInGraphNodeExecutor(
  nodeClass: GraphNodeClass
): GraphNodeExecutor {
  return {
    execute: (request, context) => {
      // Hydrate the node from the flattened canonical configuration, letting the
      // engine-resolved parameters win over the raw persisted values. The engine
      // resolves `GraphValueTemplate` user properties into `request.parameters`
      // at execution time, so a built-in node must hydrate from the resolved
      // parameters to observe them (DECAF-32 §22.4).
      //
      // Values routed onto an expose-as-port input override the filled value:
      // the user exposed the property as a port precisely so the workflow
      // supplies it (§0.2 R5 category 3).
      //
      // Persisted user-defined `state` is re-applied last (DECAF-50 §4.5 item 3,
      // merge order `metadata` → `parameters` → wired ports → `state`): resolved
      // runtime values must never clobber a `@state()` value, so the node reads
      // it through `this.*` as authored.
      const instance = nodeClass.instantiate({
        ...graphNodeConfig(context.node),
        ...(request.parameters as Record<string, unknown>),
        ...wiredGraphNodeConfiguration(request, context),
        ...((context.node.state as Record<string, unknown>) ?? {}),
      });
      return instance.execute(request, context);
    },
  };
}

/**
 * Builds the built-in node registrations (DECAF-50 §4.12): every built-in
 * manifest from {@link GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND} paired with the
 * executor derived from its authoritative backend node class.
 */
export function builtInGraphNodeRegistrations(): GraphNodeRegistration[] {
  const registrations: GraphNodeRegistration[] = [];
  for (const [kind, manifest] of Object.entries(
    GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND
  )) {
    const nodeClass = GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND[kind];
    if (!nodeClass) continue;
    registrations.push(
      defineGraphNode({ manifest, executor: builtInGraphNodeExecutor(nodeClass) })
    );
  }
  return registrations;
}

/**
 * Registers all built-in graph nodes (see
 * {@link builtInGraphNodeRegistrations}) into the given
 * {@link GraphNodeCatalogue} and returns it for chaining.
 */
export function registerBuiltInGraphNodes(
  catalogue: GraphNodeCatalogue,
  ...args: MaybeContextualArg<Context>
): GraphNodeCatalogue {
  for (const registration of builtInGraphNodeRegistrations()) {
    catalogue.register(registration, {}, ...args);
  }
  return catalogue;
}
