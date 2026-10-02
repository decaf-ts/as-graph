/**
 * @module as-graph/planning/GraphExecutionPlanner
 * @summary Topological planner for resolved graph workflows (DECAF-50 §4.9).
 * @description Turns a {@link GraphResolvedWorkflow} — the output of the
 * nine-stage §4.8 validation gate — into a {@link GraphExecutionPlan} with
 * topological layers. The planner accepts ONLY resolved workflows: it never
 * calls `graphDefinitionOf()` and never accepts `GraphWorkflowDefinition`
 * objects or inline raw `GraphNodeDefinition` objects (P3 gate). Resolution
 * against the trusted backend catalogue happens upstream, in
 * {@link GraphWorkflowDocumentValidator}.
 */
import {
  Service,
  service,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import { GRAPH_WORKFLOW_BOUNDARY } from "../constants";
import { GraphCycleError } from "../errors/GraphCycleError";
import { GraphTopologyError } from "../errors/GraphTopologyError";
import { isGraphResolvedWorkflow } from "../validation/GraphWorkflowDocumentValidator";
import type { GraphResolvedWorkflow } from "../validation/GraphResolvedWorkflow";
import type { GraphExecutionPlan } from "./GraphExecutionPlan";
import type { GraphExecutionPlanNode } from "./GraphExecutionPlanNode";
import type { GraphExecutionPlanEdge } from "./GraphExecutionPlanEdge";
import type { GraphExecutionPlanLayer } from "./GraphExecutionPlanLayer";

/**
 * Planner that turns a {@link GraphResolvedWorkflow} into a
 * {@link GraphExecutionPlan} with topological layers.
 */
@service()
export class GraphExecutionPlanner extends Service {
  constructor() {
    super();
  }

  /**
   * Plans a resolved workflow for execution.
   *
   * @param workflow - The catalogue-resolved workflow (output of the
   *   nine-stage validation gate). Raw `GraphWorkflowDefinition` objects and
   *   inline `GraphNodeDefinition` objects are rejected.
   * @returns The execution plan with nodes, edges, layers, and maps.
   * @throws {GraphTopologyError} when the input is not a resolved workflow.
   * @throws {GraphCycleError} when the workflow contains an unsupported cycle.
   */
  async plan(
    workflow: GraphResolvedWorkflow,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphExecutionPlan> {
    const { log } = (await this.logCtx(args, "plan", true)).for(this.plan);
    log.debug(`Planning resolved workflow '${workflow?.document?.id ?? "unknown"}'`);
    if (!isGraphResolvedWorkflow(workflow)) {
      throw new GraphTopologyError(
        "GraphExecutionPlanner.plan accepts only a GraphResolvedWorkflow produced by the nine-stage validation gate; raw workflow definitions and inline node definitions are rejected",
        { received: describeInput(workflow) }
      );
    }

    const nodes = this.buildPlanNodes(workflow);
    const edges = this.buildPlanEdges(workflow);

    const incomingByNode = this.buildIncomingMap(edges);
    const outgoingByNode = this.buildOutgoingMap(edges);

    const layers = this.topologicalLayers(nodes, edges);

    return {
      resolved: workflow,
      workflowId: workflow.document.id || workflow.document.name,
      nodes,
      edges,
      layers,
      incomingByNode,
      outgoingByNode,
    };
  }

  /**
   * Builds catalogue-resolved plan nodes from the resolved workflow.
   * Each plan node carries the canonical instance, the effective manifest,
   * and the trusted executor — never a raw node definition.
   */
  private buildPlanNodes(workflow: GraphResolvedWorkflow): GraphExecutionPlanNode[] {
    return workflow.nodes.map((node) => ({
      id: node.instance.id,
      kind: node.manifest.kind,
      instance: node.instance,
      manifest: node.manifest,
      executor: node.executor,
      inputPorts: node.manifest.inputs.map((port) => port.id),
      outputPorts: node.manifest.outputs.map((port) => port.id),
      connectionPorts: (node.manifest.connections ?? []).map(
        (port) => port.id
      ),
      metadata: node.instance.metadata,
    }));
  }

  /**
   * Builds plan edges from the flattened resolved edges (already validated by
   * §4.8 stage 5/6).
   */
  private buildPlanEdges(workflow: GraphResolvedWorkflow): GraphExecutionPlanEdge[] {
    return workflow.edges.map((edge) => ({
      id: edge.id,
      type: edge.type,
      sourceNodeId: edge.sourceNodeId,
      sourcePort: edge.sourcePort,
      targetNodeId: edge.targetNodeId,
      targetPort: edge.targetPort,
      ...(edge.label !== undefined ? { label: edge.label } : {}),
      metadata: edge.metadata,
    }));
  }

  /**
   * Builds a map of node id -> incoming edges (boundary excluded from keys).
   */
  private buildIncomingMap(
    edges: GraphExecutionPlanEdge[]
  ): Map<string, GraphExecutionPlanEdge[]> {
    const map = new Map<string, GraphExecutionPlanEdge[]>();
    for (const edge of edges) {
      if (edge.targetNodeId === GRAPH_WORKFLOW_BOUNDARY) continue;
      const list = map.get(edge.targetNodeId) ?? [];
      list.push(edge);
      map.set(edge.targetNodeId, list);
    }
    return map;
  }

  /**
   * Builds a map of node id -> outgoing edges (boundary targets included as
   * edge values so workflow outputs stay routable).
   */
  private buildOutgoingMap(
    edges: GraphExecutionPlanEdge[]
  ): Map<string, GraphExecutionPlanEdge[]> {
    const map = new Map<string, GraphExecutionPlanEdge[]>();
    for (const edge of edges) {
      if (edge.sourceNodeId === GRAPH_WORKFLOW_BOUNDARY) continue;
      const list = map.get(edge.sourceNodeId) ?? [];
      list.push(edge);
      map.set(edge.sourceNodeId, list);
    }
    return map;
  }

  /**
   * Produces topological layers using Kahn's algorithm.
   *
   * Workflow boundary edges do not count as executable-node dependencies.
   * Both data and structural (connection) edges count as dependencies
   * (DECAF-32 acyclicity preserved; loop constructs are excepted because
   * their bodies are separate nested documents).
   */
  private topologicalLayers(
    nodes: GraphExecutionPlanNode[],
    edges: GraphExecutionPlanEdge[]
  ): GraphExecutionPlanLayer[] {
    const executableNodes = nodes.filter(
      (n) => n.id !== GRAPH_WORKFLOW_BOUNDARY
    );
    const nodeIds = new Set(executableNodes.map((n) => n.id));

    // Only edges between two executable nodes count as dependencies
    const execEdges = edges.filter(
      (e) => nodeIds.has(e.sourceNodeId) && nodeIds.has(e.targetNodeId)
    );

    // Compute in-degree
    const indegree = new Map<string, number>();
    for (const node of executableNodes) indegree.set(node.id, 0);
    for (const edge of execEdges) {
      indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
    }

    const layers: GraphExecutionPlanLayer[] = [];
    const planned = new Set<string>();
    let ready = executableNodes.filter((n) => (indegree.get(n.id) ?? 0) === 0);
    let layerIndex = 0;

    while (ready.length > 0) {
      const layer: GraphExecutionPlanLayer = { index: layerIndex++, nodes: ready };
      layers.push(layer);
      const nextReady: GraphExecutionPlanNode[] = [];
      for (const node of ready) {
        planned.add(node.id);
        const outgoing = execEdges.filter((e) => e.sourceNodeId === node.id);
        for (const edge of outgoing) {
          const deg = (indegree.get(edge.targetNodeId) ?? 1) - 1;
          indegree.set(edge.targetNodeId, deg);
          if (deg === 0 && !planned.has(edge.targetNodeId)) {
            const next = executableNodes.find((n) => n.id === edge.targetNodeId);
            if (next) nextReady.push(next);
          }
        }
      }
      ready = nextReady;
    }

    if (planned.size !== executableNodes.length) {
      const unplanned = executableNodes
        .filter((n) => !planned.has(n.id))
        .map((n) => n.id);
      throw new GraphCycleError({
        unplannedNodes: unplanned,
        workflowId: executableNodes[0]?.manifest.kind,
      });
    }

    return layers;
  }
}

/**
 * Produces a safe, JSON-friendly description of a rejected planner input for
 * error details (never serialises executors or class instances).
 */
function describeInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return { reason: "input is not an object" };
  }
  const record = value as Record<string, unknown>;
  return {
    reason: "input is not a GraphResolvedWorkflow",
    looksLikeWorkflowDefinition:
      "nodes" in record && "relations" in record && !("nodeById" in record),
    hasResolvedNodes: Array.isArray(record["nodes"]),
  };
}
