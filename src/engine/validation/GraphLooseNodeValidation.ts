/**
 * @module as-graph/engine/validation/GraphLooseNodeValidation
 * @summary Loose-node validation (DECAF-50 §4.26 R2-3 item 8).
 * @description A node connected to nothing is a loose node and fails workflow
 * validation: every node instance must participate in at least one edge
 * (data or connection). The rule is shared by the execution gate
 * ({@link GraphWorkflowDocumentValidator}) and the persistence gate
 * ({@link validateGraphWorkflowDocumentAtBoundary}) so both start and save
 * reject a loose node. Nested loop-body documents are checked recursively.
 */
import type {
  GraphWorkflowDocument,
  GraphNodeInstance,
} from "../../shared/graph";

import type { GraphValidationIssue } from "./GraphValidationIssue";

/**
 * Records a `topology.loose-node` issue for every node instance that no edge
 * references, recursively across nested loop-body documents.
 *
 * @param document - The canonical workflow document to inspect.
 * @param issues - The accumulating issue list.
 * @param path - Dotted path prefix for reported issues.
 */
export function collectLooseNodeIssues(
  document: GraphWorkflowDocument,
  issues: GraphValidationIssue[],
  path = "$"
): void {
  const connected = new Set<string>();
  for (const edge of document.edges) {
    if (edge.source.scope === "node") connected.add(edge.source.nodeId);
    if (edge.target.scope === "node") connected.add(edge.target.nodeId);
  }
  for (const node of document.nodes) {
    if (!connected.has(node.id)) {
      issues.push({
        code: "topology.loose-node",
        path: `${path}.nodes[${node.id}]`,
        message: `Node '${node.id}' is connected to nothing; every node must participate in at least one edge`,
        nodeId: node.id,
      });
    }
    const loopBody = (node as GraphNodeInstance).loop?.body;
    if (loopBody) {
      collectLooseNodeIssues(
        loopBody,
        issues,
        `${path}.nodes[${node.id}].loop.body`
      );
    }
  }
}
