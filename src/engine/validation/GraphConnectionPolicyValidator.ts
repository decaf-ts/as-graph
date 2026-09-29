/**
 * @module as-graph/engine/validation/GraphConnectionPolicyValidator
 * @summary Connection-policy validation (DECAF-50 §4.8 stage 6).
 * @description Enforces the connection policies declared on effective ports:
 * allowed/blocked node kinds, allowed port categories, connection counts
 * (`maxConnections`, `allowMultiple`), self-connections (`allowSelf`), and
 * conflicting duplicate edges.
 */
import type { GraphValidationIssue } from "./GraphValidationIssue";
import type {
  GraphResolvedEdgeInstance,
  GraphResolvedNodeInstance,
  GraphResolvedWorkflow,
} from "./GraphResolvedWorkflow";

/**
 * Validates connection policies and edge-level structural conflicts.
 */
export class GraphConnectionPolicyValidator {
  /**
   * Stage 6 — connection policies and counts. Operates on the resolved
   * workflow (stage 5 output). Records issues; never mutates the graph.
   */
  validate(
    workflow: Pick<GraphResolvedWorkflow, "edges" | "nodeById">,
    issues: GraphValidationIssue[]
  ): void {
    this.validateDuplicates(workflow.edges, issues);
    this.validatePolicies(workflow, issues);
  }

  /**
   * Conflicting duplicate edges: two edges with identical flattened
   * endpoints (`source:port -> target:port`) are rejected, whatever their
   * ids.
   */
  private validateDuplicates(
    edges: GraphResolvedEdgeInstance[],
    issues: GraphValidationIssue[]
  ): void {
    const seen = new Map<string, GraphResolvedEdgeInstance>();
    for (const edge of edges) {
      const key = `${edge.sourceNodeId}:${edge.sourcePort}->${edge.targetNodeId}:${edge.targetPort}`;
      const previous = seen.get(key);
      if (previous) {
        issues.push({
          code: "connection.duplicate-edge",
          path: `edges[${edge.id}]`,
          message: `Edge '${edge.id}' duplicates the routing of edge '${previous.id}' (${key})`,
          edgeId: edge.id,
          details: { duplicateOf: previous.id, routing: key },
        });
        continue;
      }
      seen.set(key, edge);
    }
  }

  /**
   * Port-declared connection policies: kind allow/block lists, port
   * categories, self-connections, and connection counts.
   */
  private validatePolicies(
    workflow: Pick<GraphResolvedWorkflow, "edges" | "nodeById">,
    issues: GraphValidationIssue[]
  ): void {
    const connectionsByPort = new Map<string, GraphResolvedEdgeInstance[]>();
    for (const edge of workflow.edges) {
      if (edge.type !== "connection") continue;
      const key = `${edge.targetNodeId}:${edge.targetPort}`;
      const list = connectionsByPort.get(key) ?? [];
      list.push(edge);
      connectionsByPort.set(key, list);
    }

    for (const edge of workflow.edges) {
      if (edge.type !== "connection") continue;
      const target = workflow.nodeById.get(edge.targetNodeId);
      const policy = target?.manifest.connections?.find(
        (candidate) => candidate.id === edge.targetPort
      )?.connectionPolicy;
      this.validateEdgePolicy(edge, workflow.nodeById, policy, issues);
    }

    for (const [key, connections] of connectionsByPort) {
      const separator = key.lastIndexOf(":");
      const nodeId = key.slice(0, separator);
      const portId = key.slice(separator + 1);
      const target = workflow.nodeById.get(nodeId);
      const policy = target?.manifest.connections?.find(
        (candidate) => candidate.id === portId
      )?.connectionPolicy;
      if (!policy) continue;
      const max =
        policy.maxConnections !== undefined
          ? policy.maxConnections
          : policy.allowMultiple === false
            ? 1
            : Number.POSITIVE_INFINITY;
      if (connections.length > max) {
        issues.push({
          code: "connection.max-connections",
          path: `edges[${connections[connections.length - 1].id}]`,
          message: `Connection port '${portId}' on node '${nodeId}' accepts at most ${max} connection(s) but has ${connections.length}`,
          nodeId,
          edgeId: connections[connections.length - 1].id,
          details: { port: portId, max, actual: connections.length },
        });
      }
    }
  }

  private validateEdgePolicy(
    edge: GraphResolvedEdgeInstance,
    nodeById: Map<string, GraphResolvedNodeInstance>,
    policy:
      | {
          allowSelf?: boolean;
          allowedNodeKinds?: string[];
          blockedNodeKinds?: string[];
          allowedPortCategories?: string[];
        }
      | undefined,
    issues: GraphValidationIssue[]
  ): void {
    // Self-connections are rejected unless the policy allows them.
    if (edge.sourceNodeId === edge.targetNodeId) {
      if (!policy?.allowSelf) {
        issues.push({
          code: "connection.self-connection",
          path: `edges[${edge.id}]`,
          message: `Edge '${edge.id}' connects node '${edge.sourceNodeId}' to itself, which the target port policy does not allow`,
          edgeId: edge.id,
          nodeId: edge.sourceNodeId,
        });
        return;
      }
    }

    if (!policy) return;

    const source = nodeById.get(edge.sourceNodeId);
    const sourceKind = source?.manifest.kind;

    if (
      policy.allowedNodeKinds?.length &&
      (!sourceKind || !policy.allowedNodeKinds.includes(sourceKind))
    ) {
      issues.push({
        code: "connection.policy",
        path: `edges[${edge.id}]`,
        message: `Connection edge '${edge.id}' source kind '${sourceKind ?? "unknown"}' is not in the allowed node kinds of target port '${edge.targetPort}'`,
        edgeId: edge.id,
        nodeId: edge.sourceNodeId,
        details: { allowedNodeKinds: policy.allowedNodeKinds },
      });
    }
    if (sourceKind && policy.blockedNodeKinds?.includes(sourceKind)) {
      issues.push({
        code: "connection.policy",
        path: `edges[${edge.id}]`,
        message: `Connection edge '${edge.id}' source kind '${sourceKind}' is blocked by target port '${edge.targetPort}'`,
        edgeId: edge.id,
        nodeId: edge.sourceNodeId,
        details: { blockedNodeKinds: policy.blockedNodeKinds },
      });
    }
    if (policy.allowedPortCategories?.length) {
      const sourcePortCategory = source?.manifest.connections?.find(
        (candidate) => candidate.id === edge.sourcePort
      )?.category;
      if (
        !sourcePortCategory ||
        !policy.allowedPortCategories.includes(sourcePortCategory)
      ) {
        issues.push({
          code: "connection.policy",
          path: `edges[${edge.id}]`,
          message: `Connection edge '${edge.id}' source port '${edge.sourcePort}' category '${sourcePortCategory ?? "unknown"}' is not in the allowed port categories of target port '${edge.targetPort}'`,
          edgeId: edge.id,
          nodeId: edge.sourceNodeId,
          details: { allowedPortCategories: policy.allowedPortCategories },
        });
      }
    }
  }
}
