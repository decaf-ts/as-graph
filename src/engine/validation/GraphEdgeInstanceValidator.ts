/**
 * @module as-graph/engine/validation/GraphEdgeInstanceValidator
 * @summary Edge endpoint validation (DECAF-50 §4.8 stage 5).
 * @description Validates that edge endpoints exist (nodes, workflow ports,
 * and effective node ports), that source/target directions are valid, that
 * data and structural (connection) edges use compatible ports, and that
 * boundary routing is valid. Produces flattened
 * {@link GraphResolvedEdgeInstance}s for the planner.
 */
import type {
  GraphEdgeInstance,
  GraphWorkflowDocument,
} from "../../shared/graph";
import { isGraphNodeEndpoint, isGraphWorkflowEndpoint } from "../../shared/graph";

import { GRAPH_WORKFLOW_BOUNDARY } from "../constants";
import type { GraphResolvedNodeInstance, GraphResolvedEdgeInstance } from "./GraphResolvedWorkflow";
import type { GraphValidationIssue } from "./GraphValidationIssue";

/**
 * Validates edge instances and resolves them into flattened plan edges.
 */
export class GraphEdgeInstanceValidator {
  /**
   * Stage 5 — edge endpoints. Returns the resolved (flattened) edges for
   * every structurally valid edge; invalid edges are skipped (issues
   * recorded) so the planner only ever sees valid routing.
   *
   * Port existence/direction checks are skipped for nodes whose manifest
   * policy allows undeclared parameters (transition placeholder kinds with
   * no declared ports) — the catalogue is authoritative and those legacy
   * registrations declare no port surface to check against.
   */
  resolveEdges(
    document: GraphWorkflowDocument,
    nodesById: Map<string, GraphResolvedNodeInstance>,
    issues: GraphValidationIssue[]
  ): GraphResolvedEdgeInstance[] {
    const workflowInputs = new Set(document.inputs.map((port) => port.id));
    const workflowOutputs = new Set(document.outputs.map((port) => port.id));
    const resolved: GraphResolvedEdgeInstance[] = [];

    for (const [index, edge] of (document.edges ?? []).entries()) {
      const path = `edges[${index}]`;
      const source = this.resolveEndpoint(
        edge,
        "source",
        nodesById,
        workflowInputs,
        workflowOutputs,
        issues,
        path
      );
      const target = this.resolveEndpoint(
        edge,
        "target",
        nodesById,
        workflowInputs,
        workflowOutputs,
        issues,
        path
      );
      if (!source || !target) continue;

      const valid = this.validateDirectionAndType(
        edge,
        source,
        target,
        nodesById,
        issues,
        path
      );
      if (!valid) continue;

      const resolvedEdge: GraphResolvedEdgeInstance = {
        id: edge.id,
        type: edge.type,
        sourceNodeId: source.nodeId,
        sourcePort: source.port,
        targetNodeId: target.nodeId,
        targetPort: target.port,
        metadata: edge.metadata,
        edge,
      };
      if (edge.label !== undefined) resolvedEdge.label = edge.label;
      resolved.push(resolvedEdge);
    }
    return resolved;
  }

  private resolveEndpoint(
    edge: GraphEdgeInstance,
    side: "source" | "target",
    nodesById: Map<string, GraphResolvedNodeInstance>,
    workflowInputs: Set<string>,
    workflowOutputs: Set<string>,
    issues: GraphValidationIssue[],
    path: string
  ): { nodeId: string; port: string } | undefined {
    const endpoint = edge[side];
    if (isGraphWorkflowEndpoint(endpoint)) {
      const portKnown =
        side === "source"
          ? workflowInputs.has(endpoint.port)
          : workflowOutputs.has(endpoint.port);
      if (!portKnown) {
        issues.push({
          code: "edge.unknown-port",
          path: `${path}.${side}`,
          message: `Edge '${edge.id}' ${side} references workflow port '${endpoint.port}' which is not declared on the document boundary`,
          edgeId: edge.id,
          details: { scope: "workflow", port: endpoint.port },
        });
        return undefined;
      }
      return { nodeId: GRAPH_WORKFLOW_BOUNDARY, port: endpoint.port };
    }
    if (isGraphNodeEndpoint(endpoint)) {
      const node = nodesById.get(endpoint.nodeId);
      if (!node) {
        issues.push({
          code: "edge.unknown-node",
          path: `${path}.${side}`,
          message: `Edge '${edge.id}' ${side} references node '${endpoint.nodeId}' which is not part of the document or did not resolve`,
          edgeId: edge.id,
          nodeId: endpoint.nodeId,
        });
        return undefined;
      }
      return { nodeId: endpoint.nodeId, port: endpoint.port };
    }
    issues.push({
      code: "edge.invalid-endpoint",
      path: `${path}.${side}`,
      message: `Edge '${edge.id}' ${side} endpoint is not a valid GraphEndpoint`,
      edgeId: edge.id,
    });
    return undefined;
  }

  private validateDirectionAndType(
    edge: GraphEdgeInstance,
    source: { nodeId: string; port: string },
    target: { nodeId: string; port: string },
    nodesById: Map<string, GraphResolvedNodeInstance>,
    issues: GraphValidationIssue[],
    path: string
  ): boolean {
    let valid = true;

    const sourceNode =
      source.nodeId === GRAPH_WORKFLOW_BOUNDARY
        ? undefined
        : nodesById.get(source.nodeId);
    const targetNode =
      target.nodeId === GRAPH_WORKFLOW_BOUNDARY
        ? undefined
        : nodesById.get(target.nodeId);

    // Direction validity. Skipped for lenient placeholder manifests
    // (transition kinds with no declared port surface).
    const lenient = (node: GraphResolvedNodeInstance | undefined) =>
      node?.manifest.policies?.allowUndeclaredParameters === true;
    if (edge.type === "data") {
      // Data edges: source must be an output port (or workflow input), target
      // must be an input port (or workflow output). Connection-only ports are
      // structural and never route data.
      if (sourceNode && !lenient(sourceNode) && !this.hasPortDirection(sourceNode, source.port, "output")) {
        this.pushPortIssue(edge, "source", source, sourceNode, issues, path);
        valid = false;
      }
      if (targetNode && !lenient(targetNode) && !this.hasPortDirection(targetNode, target.port, "input")) {
        this.pushPortIssue(edge, "target", target, targetNode, issues, path);
        valid = false;
      }
    } else {
      // Structural (connection) edges: both endpoints must be connection
      // ports on real nodes — the workflow boundary never carries
      // structural edges (boundary routing validity).
      if (!sourceNode || !targetNode) {
        issues.push({
          code: "edge.boundary-routing",
          path,
          message: `Connection edge '${edge.id}' must connect two node connection ports; the workflow boundary only routes data`,
          edgeId: edge.id,
        });
        return false;
      }
      if (
        !lenient(sourceNode) && !lenient(targetNode) &&
        (!this.hasPortDirection(sourceNode, source.port, "connection") ||
          !this.hasPortDirection(targetNode, target.port, "connection"))
      ) {
        issues.push({
          code: "edge.type-mismatch",
          path,
          message: `Connection edge '${edge.id}' endpoints must both be connection ports`,
          edgeId: edge.id,
          details: {
            sourcePort: source.port,
            targetPort: target.port,
          },
        });
        return false;
      }
    }
    return valid;
  }

  private hasPortDirection(
    node: GraphResolvedNodeInstance,
    port: string,
    direction: "input" | "output" | "connection"
  ): boolean {
    const ports =
      direction === "input"
        ? node.manifest.inputs
        : direction === "output"
          ? node.manifest.outputs
          : node.manifest.connections ?? [];
    return ports.some((candidate) => candidate.id === port);
  }

  private pushPortIssue(
    edge: GraphEdgeInstance,
    side: "source" | "target",
    endpoint: { nodeId: string; port: string },
    node: GraphResolvedNodeInstance,
    issues: GraphValidationIssue[],
    path: string
  ): void {
    const expected = side === "source" ? "output" : "input";
    issues.push({
      code: edge.type === "data" ? "edge.invalid-direction" : "edge.type-mismatch",
      path: `${path}.${side}`,
      message: `Edge '${edge.id}' ${side} port '${endpoint.port}' on node '${endpoint.nodeId}' is not an ${expected} port of kind '${node.manifest.kind}'`,
      edgeId: edge.id,
      nodeId: endpoint.nodeId,
      details: { port: endpoint.port, expected },
    });
  }
}
