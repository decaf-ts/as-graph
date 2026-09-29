/**
 * @module as-graph/shared/ui/GraphWorkflowView
 * @summary Builds the framework-neutral workflow canvas view model.
 * @description Projects a canonical `GraphWorkflowDocument` plus a kind→manifest
 * map and an optional run feedback model into the {@link GraphWorkflowView} a
 * graph UI renders: the workflow boundary ports, every node instance (with its
 * effective ports and visual run state) and every edge with its resolved
 * endpoints. Pure and DOM-free, so the shared export stays frontend-safe.
 */
import { GraphVisualState } from "../graph";
import type {
  GraphEdgeInstance,
  GraphEndpoint,
  GraphNodeInstance,
  GraphWorkflowDocument,
  GraphWorkflowPortInstance,
} from "../graph";
import { graphNodeViewOf } from "./GraphNodeView";
import type { GraphNodeManifestLike } from "./GraphNodeView";
import type {
  GraphEdgeView,
  GraphEndpointView,
  GraphWorkflowPortView,
  GraphWorkflowView,
  GraphWorkflowRunView,
} from "./types";

/** Per-instance manifest resolver consumed by the workflow view builder. */
export type GraphManifestLookup = (
  instance: GraphNodeInstance
) => GraphNodeManifestLike | undefined;

/** Projects a workflow boundary port into its view model. */
function workflowPortViewOf(
  port: GraphWorkflowPortInstance
): GraphWorkflowPortView {
  return {
    id: port.id,
    label: port.label ?? port.id,
    required: port.required === true,
    schema: port.schema,
  };
}

/** Projects an edge endpoint into its view model. */
export function graphEndpointViewOf(
  endpoint: GraphEndpoint
): GraphEndpointView {
  if (endpoint.scope === "workflow") {
    return { scope: "workflow", port: endpoint.port };
  }
  return { scope: "node", nodeId: endpoint.nodeId, port: endpoint.port };
}

/** Projects an edge instance into its view model. */
export function graphEdgeViewOf(edge: GraphEdgeInstance): GraphEdgeView {
  return {
    id: edge.id,
    type: edge.type,
    source: graphEndpointViewOf(edge.source),
    target: graphEndpointViewOf(edge.target),
    label: edge.label,
    visualState: GraphVisualState.IDLE,
  };
}

/**
 * Synthesizes a minimal manifest for an unknown node kind so the canvas can
 * still render a placeholder node instead of dropping it.
 */
function fallbackManifestOf(instance: GraphNodeInstance): GraphNodeManifestLike {
  return {
    kind: instance.kind,
    display: { name: instance.label ?? instance.kind },
    inputs: [],
    outputs: [],
    parameters: [],
  };
}

/**
 * Builds the view model for a whole workflow document.
 *
 * @param document - The canonical workflow document.
 * @param manifests - Per-instance manifest resolver for the document's nodes.
 * @param run - The optional run feedback model.
 * @returns The workflow view model.
 */
export function graphWorkflowViewOf(
  document: GraphWorkflowDocument,
  manifests: GraphManifestLookup,
  run?: GraphWorkflowRunView
): GraphWorkflowView {
  const nodes = document.nodes.map((instance) =>
    graphNodeViewOf(
      manifests(instance) ?? fallbackManifestOf(instance),
      instance,
      run?.nodes[instance.id]
    )
  );
  return {
    id: document.id,
    name: document.name,
    inputs: document.inputs.map(workflowPortViewOf),
    outputs: document.outputs.map(workflowPortViewOf),
    nodes,
    edges: document.edges.map(graphEdgeViewOf),
    run,
  };
}
