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

function executorOf(nodeClass: GraphNodeClass): GraphNodeExecutor {
  return {
    execute: (request, context) => {
      // Hydrate the node from the flattened canonical configuration, letting the
      // engine-resolved parameters win over the raw persisted values. The engine
      // resolves `GraphValueTemplate` user properties into `request.parameters`
      // at execution time, so a built-in node must hydrate from the resolved
      // parameters to observe them (DECAF-32 §22.4).
      //
      // Persisted user-defined `state` is re-applied last (DECAF-50 §4.5 item 3,
      // merge order `metadata` → `parameters` → `state`): resolved runtime
      // parameters must never clobber a `@state()` value, so the node reads it
      // through `this.*` as authored.
      const instance = nodeClass.instantiate({
        ...graphNodeConfig(context.node),
        ...(request.parameters as Record<string, unknown>),
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
      defineGraphNode({ manifest, executor: executorOf(nodeClass) })
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
