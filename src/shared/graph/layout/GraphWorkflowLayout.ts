import type { ELK, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { GRAPH_DEFAULT_NODE_SIZE } from "../constants";
import type { GraphNodeEndpoint } from "../document/GraphEndpoint";
import type { GraphNodeInstance } from "../document/GraphNodeInstance";
import type { GraphWorkflowDocument } from "../document/GraphWorkflowDocument";
import {
  buildLayoutOptions,
  type GraphLayoutOptions,
} from "./layout-options";

/**
 * A 2D point in canvas coordinates. Matches `GraphNodeUiState.position` and the
 * `GraphEdgeUiState.points` waypoint shape.
 */
export interface GraphLayoutPoint {
  x: number;
  y: number;
}

/**
 * Deterministic result of `computeGraphWorkflowLayout`.
 *
 * - `nodes` maps every document node id to its laid-out top-left `{x,y}`.
 * - `edges` is present only when at least one edge has routed waypoints, mapping
 *   the edge id to its ordered polyline `{x,y}` points.
 */
export interface GraphWorkflowLayoutResult {
  nodes: Record<string, GraphLayoutPoint>;
  edges?: Record<string, GraphLayoutPoint[]>;
}

type ElkGraph = ElkNode & { edges?: ElkExtendedEdge[] };

const DIMENSIONS = ["width", "height"] as const;

function dimensionOf(
  node: GraphNodeInstance,
  dimension: (typeof DIMENSIONS)[number]
): number {
  const value = node.ui?.size?.[dimension];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : GRAPH_DEFAULT_NODE_SIZE;
}

/**
 * Pure transform of a workflow document into the ELK layered input graph. It reads
 * the document without mutating it; only node→node edges are forwarded (workflow
 * boundary edges have no canvas node to route between). Node sizes come from the
 * persisted `GraphNodeUiState.size` when present, otherwise the shared
 * {@link GRAPH_DEFAULT_NODE_SIZE} display default.
 */
export function toElkGraph(
  document: GraphWorkflowDocument,
  options?: GraphLayoutOptions
): ElkGraph {
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const edges: ElkExtendedEdge[] = [];
  for (const edge of document.edges) {
    const { source, target } = edge;
    if (!isNodeEndpoint(source) || !isNodeEndpoint(target)) continue;
    if (!nodeIds.has(source.nodeId) || !nodeIds.has(target.nodeId)) continue;
    edges.push({
      id: edge.id,
      sources: [source.nodeId],
      targets: [target.nodeId],
    });
  }
  return {
    id: document.id,
    layoutOptions: buildLayoutOptions(options),
    children: document.nodes.map((node) => ({
      id: node.id,
      width: dimensionOf(node, "width"),
      height: dimensionOf(node, "height"),
    })),
    edges,
  };
}

function isNodeEndpoint(
  endpoint: GraphWorkflowDocument["edges"][number]["source"]
): endpoint is GraphNodeEndpoint {
  return endpoint.scope === "node" && typeof endpoint.nodeId === "string";
}

function edgePoints(edge: ElkExtendedEdge): GraphLayoutPoint[] {
  const points: GraphLayoutPoint[] = [];
  for (const section of edge.sections ?? []) {
    points.push({ x: section.startPoint.x, y: section.startPoint.y });
    for (const bend of section.bendPoints ?? []) {
      points.push({ x: bend.x, y: bend.y });
    }
    points.push({ x: section.endPoint.x, y: section.endPoint.y });
  }
  return points;
}

/**
 * Pure projection of an ELK layout result back onto document ids. Node keys follow
 * the document's node order; edge keys follow the document's edge order. The input
 * document is only read, never mutated.
 */
export function fromElkLayout(
  laidOut: ElkGraph,
  document: GraphWorkflowDocument
): GraphWorkflowLayoutResult {
  const positions = new Map<string, GraphLayoutPoint>();
  for (const child of laidOut.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  const nodes: Record<string, GraphLayoutPoint> = {};
  for (const node of document.nodes) {
    nodes[node.id] = positions.get(node.id) ?? { x: 0, y: 0 };
  }

  const routed = new Map<string, GraphLayoutPoint[]>();
  for (const edge of laidOut.edges ?? []) {
    const points = edgePoints(edge);
    if (points.length > 0) routed.set(edge.id, points);
  }
  const edges: Record<string, GraphLayoutPoint[]> = {};
  for (const edge of document.edges) {
    const points = routed.get(edge.id);
    if (points) edges[edge.id] = points;
  }

  return Object.keys(edges).length > 0 ? { nodes, edges } : { nodes };
}

async function createElk(): Promise<ELK> {
  // Dynamic import keeps elkjs out of the eager shared bundle; only the editor
  // path that calls this module pays for it, on demand.
  const module = await import("elkjs/lib/elk.bundled.js");
  const Constructor = (module.default ?? module) as unknown as new () => ELK;
  return new Constructor();
}

/**
 * Computes a deterministic, left-to-right layout for a workflow document.
 *
 * The function is pure with respect to the document (it is never mutated) and
 * deterministic (same document + options yields byte-identical output). It returns a
 * Promise because ELK's `layout()` is asynchronous; `toElkGraph` and
 * `fromElkLayout` are synchronous and side-effect free.
 */
export async function computeGraphWorkflowLayout(
  document: GraphWorkflowDocument,
  options?: GraphLayoutOptions
): Promise<GraphWorkflowLayoutResult> {
  const graph = toElkGraph(document, options);
  const elk = await createElk();
  const laidOut = await elk.layout(graph);
  return fromElkLayout(laidOut as ElkGraph, document);
}
