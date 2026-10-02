import { ValidationError } from "@decaf-ts/db-decorators";
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import {
  assertGraphWorkflowDocumentValid,
  isGraphJsonSafeValue,
  isGraphWorkflowDocumentShape,
  type GraphJsonPrimitive,
  type GraphWorkflowDocument,
  type GraphWorkflowPortInstance,
} from "../../shared/graph";
import type { GraphNodeCatalogue } from "../catalog/GraphNodeCatalogue";
import { collectLooseNodeIssues } from "./GraphLooseNodeValidation";
import type {
  GraphValidationIssue,
  GraphWorkflowValidationResult,
} from "./GraphValidationIssue";
import {
  DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS,
  type GraphWorkflowDocumentLimits,
} from "./GraphWorkflowDocumentLimits";

/**
 * Field keys that must never appear on a submitted workflow document or any
 * of its structural records (DECAF-50 §4.16): client input resembling node,
 * definition, executor, authoritative ports, or frontend component
 * definitions is rejected at the boundary.
 */
export const GRAPH_WORKFLOW_FORBIDDEN_FIELD_KEYS: readonly string[] = [
  "node",
  "definition",
  "executor",
  "execute",
  "ports",
  "component",
];

/** Options for boundary validation: document resource limits and the trusted catalogue to resolve kinds against. */
export interface GraphWorkflowBoundaryValidationOptions {
  limits?: GraphWorkflowDocumentLimits;
  catalogue?: GraphNodeCatalogue;
}

function issue(
  code: string,
  path: string,
  message: string,
  extra?: { nodeId?: string; edgeId?: string; details?: Record<string, GraphJsonPrimitive> }
): GraphValidationIssue {
  return {
    code,
    path,
    message,
    ...(extra?.nodeId !== undefined ? { nodeId: extra.nodeId } : {}),
    ...(extra?.edgeId !== undefined ? { edgeId: extra.edgeId } : {}),
    ...(extra?.details ? { details: extra.details } : {}),
  };
}

function forbiddenFieldIssues(
  record: Record<string, unknown>,
  path: string
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  for (const key of Object.keys(record)) {
    if (GRAPH_WORKFLOW_FORBIDDEN_FIELD_KEYS.includes(key)) {
      issues.push(
        issue(
          "document.forbidden-field",
          `${path}.${key}`,
          `Field '${key}' is not accepted in a canonical workflow document: node, definition, executor, execute, ports and component fields are rejected at the boundary`,
          {
            details: { field: key },
          }
        )
      );
    }
  }
  return issues;
}

function collectForbiddenFieldIssues(
  document: GraphWorkflowDocument,
  issues: GraphValidationIssue[]
): void {
  issues.push(...forbiddenFieldIssues(document as unknown as Record<string, unknown>, "$"));
  document.inputs.forEach((port, index) =>
    issues.push(
      ...forbiddenFieldIssues(port as unknown as Record<string, unknown>, `inputs[${index}]`)
    )
  );
  document.outputs.forEach((port, index) =>
    issues.push(
      ...forbiddenFieldIssues(port as unknown as Record<string, unknown>, `outputs[${index}]`)
    )
  );
  for (const node of document.nodes) {
    issues.push(
      ...forbiddenFieldIssues(node as unknown as Record<string, unknown>, `nodes[${node.id}]`)
    );
    if (node.loop) {
      issues.push(
        ...forbiddenFieldIssues(
          node.loop as unknown as Record<string, unknown>,
          `nodes[${node.id}].loop`
        )
      );
      collectForbiddenFieldIssues(node.loop.body, issues);
    }
  }
  for (const edge of document.edges) {
    issues.push(
      ...forbiddenFieldIssues(edge as unknown as Record<string, unknown>, `edges[${edge.id}]`)
    );
  }
}

function duplicateIdIssues(document: GraphWorkflowDocument): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const portIds = new Set<string>();
  for (const port of [...document.inputs, ...document.outputs] as GraphWorkflowPortInstance[]) {
    if (portIds.has(port.id)) {
      issues.push(
        issue(
          "document.duplicate-port-id",
          `ports[${port.id}]`,
          `Workflow port '${port.id}' is declared more than once; workflow port ids must be unique`
        )
      );
    } else {
      portIds.add(port.id);
    }
  }
  const nodeIds = new Set<string>();
  for (const node of document.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push(
        issue(
          "document.duplicate-node-id",
          `nodes[${node.id}]`,
          `Node '${node.id}' is declared more than once; node ids must be unique`,
          { nodeId: node.id }
        )
      );
    } else {
      nodeIds.add(node.id);
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push(
        issue(
          "document.duplicate-edge-id",
          `edges[${edge.id}]`,
          `Edge '${edge.id}' is declared more than once; edge ids must be unique`,
          { edgeId: edge.id }
        )
      );
    } else {
      edgeIds.add(edge.id);
    }
  }
  return issues;
}

function limitIssues(
  document: GraphWorkflowDocument,
  limits: Required<GraphWorkflowDocumentLimits>
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  if (document.nodes.length > limits.maxNodes) {
    issues.push(
      issue(
        "document.limit.nodes",
        "$.nodes",
        `Document declares ${document.nodes.length} nodes; at most ${limits.maxNodes} are allowed`,
        { details: { count: document.nodes.length, limit: limits.maxNodes } }
      )
    );
  }
  if (document.edges.length > limits.maxEdges) {
    issues.push(
      issue(
        "document.limit.edges",
        "$.edges",
        `Document declares ${document.edges.length} edges; at most ${limits.maxEdges} are allowed`,
        { details: { count: document.edges.length, limit: limits.maxEdges } }
      )
    );
  }
  const maxDepth = maxNestingDepthOf(document);
  if (maxDepth > limits.maxNestingDepth) {
    issues.push(
      issue(
        "document.limit.depth",
        "$.nodes",
        `Document nests loop bodies ${maxDepth} levels deep; at most ${limits.maxNestingDepth} levels are allowed`,
        { details: { depth: maxDepth, limit: limits.maxNestingDepth } }
      )
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  if (bytes > limits.maxDocumentBytes) {
    issues.push(
      issue(
        "document.limit.size",
        "$",
        `Document serializes to ${bytes} bytes; at most ${limits.maxDocumentBytes} bytes are allowed`,
        { details: { bytes, limit: limits.maxDocumentBytes } }
      )
    );
  }
  return issues;
}

function maxNestingDepthOf(document: GraphWorkflowDocument, depth = 0): number {
  let max = depth;
  for (const node of document.nodes) {
    if (node.loop?.body) {
      max = Math.max(max, maxNestingDepthOf(node.loop.body, depth + 1));
    }
  }
  return max;
}

async function kindIssues(
  document: GraphWorkflowDocument,
  catalogue: GraphNodeCatalogue,
  ...args: MaybeContextualArg<Context>
): Promise<GraphValidationIssue[]> {
  const issues: GraphValidationIssue[] = [];
  for (const node of document.nodes) {
    if (!catalogue.has(node.kind, ...args)) {
      issues.push(
        issue(
          "node.unknown-kind",
          `nodes[${node.id}].kind`,
          `Node '${node.id}' references kind '${node.kind}' which is not registered in the backend catalogue`,
          { nodeId: node.id, details: { kind: node.kind } }
        )
      );
    }
    if (node.loop?.body) {
      issues.push(...(await kindIssues(node.loop.body, catalogue, ...args)));
    }
  }
  return issues;
}

/**
 * Validates a submitted canonical workflow document at the persistence
 * boundary (DECAF-50 §4.10/§4.16): document shape, JSON safety, forbidden
 * definition/executor/component fields, duplicate ids, backend-enforced
 * resource limits, structural validity (via the shared document contract
 * assertions) and catalogue kind existence. Issues accumulate as structured
 * {@link GraphValidationIssue}s instead of failing abruptly.
 *
 * Full nine-stage document/catalogue validation (DECAF-50 §4.8) is owned by
 * the engine validation phase; this boundary pass is the persistence gate.
 */
export async function validateGraphWorkflowDocumentAtBoundary(
  document: GraphWorkflowDocument,
  options: GraphWorkflowBoundaryValidationOptions = {},
  ...args: MaybeContextualArg<Context>
): Promise<GraphWorkflowValidationResult> {
  const limits = {
    ...DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS,
    ...options.limits,
  };
  const issues: GraphValidationIssue[] = [];

  if (!isGraphWorkflowDocumentShape(document)) {
    issues.push(
      issue(
        "document.shape",
        "$",
        "Payload is not a canonical GraphWorkflowDocument: id and name must be strings and inputs, outputs, nodes and edges must be arrays"
      )
    );
    return { valid: false, issues };
  }

  if (!isGraphJsonSafeValue(document)) {
    issues.push(
      issue(
        "document.json-unsafe",
        "$",
        "Document contains JSON-unsafe values: functions, class instances, undefined, NaN/Infinity, symbol keys and unsafe prototype keys (__proto__/prototype/constructor) are rejected"
      )
    );
    return { valid: false, issues };
  }

  collectForbiddenFieldIssues(document, issues);
  issues.push(...duplicateIdIssues(document));
  issues.push(...limitIssues(document, limits));
  collectLooseNodeIssues(document, issues);

  try {
    assertGraphWorkflowDocumentValid(document);
  } catch (e: unknown) {
    const message = e instanceof ValidationError ? e.message : String(e);
    issues.push(issue("document.structure", "$", message));
  }

  if (options.catalogue) {
    issues.push(...(await kindIssues(document, options.catalogue, ...args)));
  }

  return { valid: issues.length === 0, issues };
}
