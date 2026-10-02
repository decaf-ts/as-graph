/**
 * @module as-graph/tests/fixtures/workflows/builders
 * @summary Tiny canonical-document builders shared by the persisted demo
 * workflow fixtures (SAA-2049 / SAA-2015 W4b).
 * @description Keeps the fixture modules declarative: each workflow only names
 * its nodes and edges, while these helpers own the canonical
 * `GraphWorkflowDocument` shape.
 */
import type {
  GraphEdgeInstance,
  GraphEndpoint,
  GraphNodeInstance,
  GraphWorkflowDocument,
  GraphWorkflowPortInstance,
} from "../../../src/shared/graph";

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
  return { id, kind, parameters, ...extra };
}

/** Builds a canonical edge instance from `[scope, ...]` endpoint triples. */
export function edge(
  id: string,
  source: ["node", string, string] | ["workflow", string],
  target: ["node", string, string] | ["workflow", string],
  type: "data" | "connection" = "data"
): GraphEdgeInstance {
  const endpoint = (
    value: ["node", string, string] | ["workflow", string]
  ): GraphEndpoint =>
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
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.ui ? { ui: input.ui } : {}),
  };
}
