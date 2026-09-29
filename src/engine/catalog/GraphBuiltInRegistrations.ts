/**
 * @module as-graph/engine/catalog/GraphBuiltInRegistrations
 * @summary Built-in graph node registrations (DECAF-50 §4.12, §4.26 R2-1).
 * @description Derives every built-in {@link GraphNodeRegistration} from its
 * authoritative backend node class: the published manifest comes from
 * `GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND` and the executor is the class's
 * `execute` static method. Because node classes reach the engine through
 * `GraphExecutionContext.engine`, no executor needs an engine back-reference and
 * every built-in kind is registered in a single pass.
 */
import type { GraphExecutionValues, GraphNodeExecutionRequest } from "../types";
import type { GraphNodeExecutor } from "../execution/GraphNodeExecutor";
import type { GraphExecutionContext } from "../execution/GraphExecutionContext";
import {
  GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND,
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
} from "../../node";
import { GraphNodeCatalogue } from "./GraphNodeCatalogue";
import {
  defineGraphNode,
  type GraphNodeRegistration,
} from "./GraphNodeRegistration";

function executorOf(
  nodeClass: {
    execute(
      request: GraphNodeExecutionRequest,
      context: GraphExecutionContext
    ): GraphExecutionValues | Promise<GraphExecutionValues>;
  }
): GraphNodeExecutor {
  return {
    execute: (request, context) => nodeClass.execute(request, context),
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
  catalogue: GraphNodeCatalogue
): GraphNodeCatalogue {
  for (const registration of builtInGraphNodeRegistrations()) {
    catalogue.register(registration);
  }
  return catalogue;
}
