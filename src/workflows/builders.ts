/**
 * @module as-graph/workflows/builders
 * @summary Tiny canonical-document builders shared by the persisted demo
 * workflow fixtures (SAA-2049 / SAA-2015 W4b).
 * @description Keeps the fixture modules declarative: each workflow only names
 * its nodes and edges, while these helpers own the canonical
 * `GraphWorkflowDocument` shape.
 */
import type {
  GraphEdgeInstance,
  GraphEndpoint,
  GraphJsonValue,
  GraphNodeInstance,
  GraphWorkflowDocument,
  GraphWorkflowPortInstance,
} from "../shared/graph";

/** Builds a minimal workflow boundary port instance. */
export function port(
  id: string,
  extra: Partial<GraphWorkflowPortInstance> = {}
): GraphWorkflowPortInstance {
  return { id, ...extra };
}

/** Builds a canonical node instance with required `parameters`. */
export function node(
  id: string,
  kind: string,
  parameters: Record<string, unknown> = {},
  extra: Partial<GraphNodeInstance> = {}
): GraphNodeInstance {
  return {
    id,
    kind,
    parameters: parameters as Record<string, GraphJsonValue>,
    ...extra,
  };
}

export type GraphEndpointInput = ["node", string, string] | ["workflow", string];

/**
 * Builds a canonical edge instance from `[scope, ...]` endpoint triples
 * ({@link GraphEndpointInput}): a node port (`["node", nodeId, port]`) or a
 * workflow boundary port (`["workflow", port]`).
 */
export function edge(
  id: string,
  source: GraphEndpointInput,
  target: GraphEndpointInput,
  type: "data" | "connection" = "data"
): GraphEdgeInstance {
  const endpoint = (value: GraphEndpointInput): GraphEndpoint =>
    value[0] === "node"
      ? { scope: "node", nodeId: value[1], port: value[2] }
      : { scope: "workflow", port: value[1] };
  return { id, type, source: endpoint(source), target: endpoint(target) };
}

/** Builds a canonical workflow document. */
export function document(input: {
  id: string;
  name?: string;
  inputs?: GraphWorkflowPortInstance[];
  outputs?: GraphWorkflowPortInstance[];
  nodes: GraphNodeInstance[];
  edges?: GraphEdgeInstance[];
  metadata?: Record<string, unknown>;
  ui?: Record<string, unknown>;
}): GraphWorkflowDocument {
  return {
    id: input.id,
    name: input.name ?? input.id,
    inputs: input.inputs ?? [],
    outputs: input.outputs ?? [],
    nodes: input.nodes,
    edges: input.edges ?? [],
    ...(input.metadata
      ? { metadata: input.metadata as Record<string, GraphJsonValue> }
      : {}),
    ...(input.ui ? { ui: input.ui as Record<string, GraphJsonValue> } : {}),
  };
}
