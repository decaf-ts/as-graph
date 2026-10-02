/**
 * @module as-graph/engine/validation/GraphWorkflowDocumentValidator
 * @summary Nine-stage backend workflow-document validation gate (DECAF-50 §4.8).
 * @description Validates a canonical {@link GraphWorkflowDocument} and, when
 * valid, resolves it into a backend-only {@link GraphResolvedWorkflow} — the
 * only input the {@link GraphExecutionPlanner} accepts. The nine stages run
 * in the EXACT normative order 1→9:
 *
 * 1. workflow structure (shape, JSON safety, unique ids, backend-enforced
 *    limits, forbidden definition/executor fields, recursive nested loop-body
 *    validation),
 * 2. kind resolution against the trusted backend catalogue,
 * 3. parameters (declared-ness, required presence, typing, metadata keys,
 *    disabled behavior, binding shapes),
 * 4. dynamic ports (binding ids refer to effective ports),
 * 5. edge endpoints (existence, direction, data/structural compatibility,
 *    boundary routing),
 * 6. connection policy (policies, counts, duplicates, self-connections),
 * 7. topology (acyclicity, binding satisfaction, required-value
 *    satisfiability),
 * 8. credential-reference authorization (existence, authorization, type
 *    match, no plain secrets),
 * 9. capability validation.
 *
 * Issues accumulate as structured {@link GraphValidationIssue}s — validation
 * never fails abruptly; a document with any issue is reported invalid and is
 * never resolved. Fail-fast consumers (the execution engine) throw
 * {@link GraphDocumentValidationError} on invalid results.
 */
import type {
  GraphWorkflowDocument,
  GraphWorkflowPortInstance,
} from "../../shared/graph";
import {
  assertGraphWorkflowDocumentValid,
  isGraphJsonSafeValue,
  isGraphNodeCapability,
  isGraphWorkflowDocumentShape,
} from "../../shared/graph";

import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import { GRAPH_WORKFLOW_BOUNDARY } from "../constants";
import type { GraphNodeCatalogue } from "../catalog/GraphNodeCatalogue";
import type {
  GraphNodeResolutionContext,
  GraphResolvedNodeManifest,
} from "../../shared/graph";
import { GraphNodeInstanceValidator } from "./GraphNodeInstanceValidator";
import { collectLooseNodeIssues } from "./GraphLooseNodeValidation";
import { GraphParameterValidator } from "./GraphParameterValidator";
import { GraphEdgeInstanceValidator } from "./GraphEdgeInstanceValidator";
import { GraphConnectionPolicyValidator } from "./GraphConnectionPolicyValidator";
import { GraphCredentialReferenceValidator } from "./GraphCredentialReferenceValidator";
import type { GraphCredentialAuthorizer } from "./GraphCredentialReferenceValidator";
import { GraphDocumentValidationError } from "./GraphValidationErrors";
import type { GraphValidationIssue, GraphWorkflowValidationResult } from "./GraphValidationIssue";
import type {
  GraphResolvedEdgeInstance,
  GraphResolvedNodeInstance,
  GraphResolvedWorkflow,
} from "./GraphResolvedWorkflow";

/**
 * Backend-enforced, configurable document resource limits (DECAF-50 §4.8).
 * Mirrors the persistence-boundary limits; every value is overridable.
 */
export interface GraphWorkflowDocumentValidationLimits {
  /** Maximum serialized size of the document in bytes. */
  maxDocumentBytes?: number;
  /** Maximum nested loop-body document depth (root document is depth 0). */
  maxNestingDepth?: number;
  /** Maximum node instances per document level. */
  maxNodes?: number;
  /** Maximum edge instances per document level. */
  maxEdges?: number;
}

/**
 * Default resource limits (technical governance delegates the numbers to
 * implementation; these match the persistence boundary defaults).
 */
export const DEFAULT_GRAPH_WORKFLOW_VALIDATION_LIMITS: Required<GraphWorkflowDocumentValidationLimits> =
  {
    maxDocumentBytes: 2_000_000,
    maxNestingDepth: 10,
    maxNodes: 500,
    maxEdges: 1_000,
  };

/**
 * Field keys that must never appear on a workflow document or any of its
 * structural records: client input resembling node definitions, executors,
 * authoritative ports, or frontend component definitions is rejected before
 * kind resolution (the planner must never see raw definitions).
 */
export const GRAPH_DOCUMENT_FORBIDDEN_FIELD_KEYS: readonly string[] = [
  "node",
  "definition",
  "executor",
  "execute",
  "ports",
  "component",
];

/**
 * Options controlling the nine-stage validation gate.
 */
export interface GraphWorkflowDocumentValidatorOptions {
  /** Trusted backend kind catalogue (required). */
  catalogue: GraphNodeCatalogue;
  /** Backend-enforced resource limits; defaults to {@link DEFAULT_GRAPH_WORKFLOW_VALIDATION_LIMITS}. */
  limits?: GraphWorkflowDocumentValidationLimits;
  /** Pluggable credential existence/authorization hook (DECAF-50 §4.16). */
  credentialAuthorizer?: GraphCredentialAuthorizer;
  /** Extra context passed to manifest resolution (credentials, request context). */
  resolutionContext?: GraphNodeResolutionContext;
  /**
   * Transition leniency (§4.18): when `true`, a port with an incoming edge
   * may also carry a literal binding. Defaults to `false` (conflicting
   * literal+edge bindings are rejected).
   */
  allowLiteralAndEdgeBindings?: boolean;
}

/**
 * Returns `true` when the value structurally looks like a resolved workflow
 * (resolved node instances + resolved edges + lookup maps over a canonical
 * document). Used as the planner's runtime input guard.
 *
 * @returns {boolean} `true` when the value is a resolved workflow.
 */
export function isGraphResolvedWorkflow(
  value: unknown
): value is GraphResolvedWorkflow {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isGraphWorkflowDocumentShape(record["document"]) &&
    Array.isArray(record["nodes"]) &&
    Array.isArray(record["edges"]) &&
    record["nodeById"] instanceof Map &&
    record["incomingByNode"] instanceof Map &&
    record["outgoingByNode"] instanceof Map &&
    (record["nodes"] as unknown[]).every(
      (node) =>
        node !== null &&
        typeof node === "object" &&
        typeof (node as Record<string, unknown>)["instance"] === "object" &&
        typeof (node as Record<string, unknown>)["manifest"] === "object" &&
        typeof (node as Record<string, unknown>)["executor"] === "object"
    )
  );
}

function forbiddenFieldIssues(
  record: Record<string, unknown>,
  path: string
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  for (const key of Object.keys(record)) {
    if (GRAPH_DOCUMENT_FORBIDDEN_FIELD_KEYS.includes(key)) {
      issues.push({
        code: "document.forbidden-field",
        path: `${path}.${key}`,
        message: `Field '${key}' is not accepted in a canonical workflow document: node, definition, executor, execute, ports and component fields are rejected`,
        details: { field: key },
      });
    }
  }
  return issues;
}

/**
 * Collects, per node id, the input port ids targeted by an incoming data
 * edge. Used by the stage-3 parameter pass for cross-satisfaction
 * (§4.4.5 rules 1/5/7): a required parameter whose id matches an
 * edge-satisfied input port is carried by that edge and needs no redundant
 * `parameters[id]` entry. This only reads the raw document — edge
 * existence, direction and type are still validated at stage 5.
 */
function collectEdgeSatisfiedInputPorts(
  document: GraphWorkflowDocument
): Map<string, Set<string>> {
  const satisfied = new Map<string, Set<string>>();
  for (const edge of document.edges ?? []) {
    if (edge.type !== "data") continue;
    const target = edge.target;
    if (target.scope !== "node") continue;
    const ports = satisfied.get(target.nodeId) ?? new Set<string>();
    ports.add(target.port);
    satisfied.set(target.nodeId, ports);
  }
  return satisfied;
}

/**
 * The nine-stage backend validation gate (DECAF-50 §4.8).
 *
 * Usage: `const result = await validator.validate(document);` — inspect
 * `result.issues` (structured, in stage order) and `result.resolved` (present
 * only when valid). Use {@link GraphWorkflowDocumentValidator.validateOrThrow}
 * for the fail-fast engine path.
 */
export class GraphWorkflowDocumentValidator {
  private readonly nodeValidator: GraphNodeInstanceValidator;
  private readonly parameterValidator = new GraphParameterValidator();
  private readonly edgeValidator = new GraphEdgeInstanceValidator();
  private readonly connectionPolicyValidator = new GraphConnectionPolicyValidator();
  private readonly credentialValidator: GraphCredentialReferenceValidator;

  constructor(private readonly options: GraphWorkflowDocumentValidatorOptions) {
    this.nodeValidator = new GraphNodeInstanceValidator(options.catalogue);
    this.credentialValidator = new GraphCredentialReferenceValidator(
      options.credentialAuthorizer
    );
  }

  /**
   * Fail-fast variant of {@link validate}: resolves the document or throws
   * {@link GraphDocumentValidationError} carrying every structured issue.
   */
  async validateOrThrow(
    document: GraphWorkflowDocument,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphResolvedWorkflow> {
    const result = await this.validate(document, 0, ...args);
    if (!result.valid || !result.resolved) {
      throw new GraphDocumentValidationError(
        `Graph workflow document '${document.id}' failed validation with ${result.issues.length} issue(s)`,
        result.issues
      );
    }
    return result.resolved;
  }

  /**
   * Runs the nine validation stages in the exact normative order 1→9 and,
   * when the document is fully valid, resolves it against the backend
   * catalogue.
   *
   * @param document - The canonical workflow document to validate.
   * @param depth - Current nesting depth (root is 0); enforced against
   *   `limits.maxNestingDepth` and used to guard recursive loop-body
   *   validation.
   * @returns The validation result with accumulated issues and, when valid,
   *   the resolved workflow.
   */
  async validate(
    document: GraphWorkflowDocument,
    depth = 0,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowValidationResult> {
    const issues: GraphValidationIssue[] = [];
    const limits = {
      ...DEFAULT_GRAPH_WORKFLOW_VALIDATION_LIMITS,
      ...this.options.limits,
    };

    // ------------------------------------------------------------------
    // Stage 1 — workflow structure.
    // ------------------------------------------------------------------
    if (!(await this.validateStructure(document, limits, depth, issues, ...args))) {
      return { valid: false, issues };
    }

    // ------------------------------------------------------------------
    // Stage 2 — kind resolution (trusted backend catalogue).
    // ------------------------------------------------------------------
    const nodeById = await this.nodeValidator.resolveNodes(
      document.nodes,
      issues,
      this.options.resolutionContext,
      ...args
    );
    const resolvedNodes: GraphResolvedNodeInstance[] = document.nodes
      .filter((node) => nodeById.has(node.id))
      .map((node) => nodeById.get(node.id)!);

    // ------------------------------------------------------------------
    // Stage 3 — parameters (declared-ness, required presence, typing,
    // metadata keys, disabled behavior, binding shapes).
    //
    // Cross-satisfaction (§4.4.5 rules 1/5/7): a required parameter whose
    // id matches an input port may be carried on the input surface instead.
    // The edge-satisfied port set is derived from the raw document here so
    // the parameter pass can see an incoming data edge without reordering
    // the normative stages (edges are still resolved and validated at stage 5).
    // ------------------------------------------------------------------
    const edgeSatisfiedInputPorts = collectEdgeSatisfiedInputPorts(document);
    for (const node of resolvedNodes) {
      this.parameterValidator.validate(
        node.instance,
        node.manifest,
        issues,
        `nodes[${node.instance.id}]`,
        edgeSatisfiedInputPorts.get(node.instance.id)
      );
    }

    // ------------------------------------------------------------------
    // Stage 4 — dynamic ports (binding ids refer to effective ports).
    // ------------------------------------------------------------------
    for (const node of resolvedNodes) {
      this.nodeValidator.validateEffectivePorts(
        node.instance,
        node.manifest,
        issues,
        `nodes[${node.instance.id}]`
      );
    }

    // ------------------------------------------------------------------
    // Stage 5 — edge endpoints (existence, direction, type compatibility,
    // boundary routing). Produces the flattened resolved edges.
    // ------------------------------------------------------------------
    const edges = this.edgeValidator.resolveEdges(document, nodeById, issues);
    const incomingByNode = new Map<string, GraphResolvedEdgeInstance[]>();
    const outgoingByNode = new Map<string, GraphResolvedEdgeInstance[]>();
    for (const edge of edges) {
      if (edge.targetNodeId !== GRAPH_WORKFLOW_BOUNDARY) {
        const incoming = incomingByNode.get(edge.targetNodeId) ?? [];
        incoming.push(edge);
        incomingByNode.set(edge.targetNodeId, incoming);
      }
      if (edge.sourceNodeId !== GRAPH_WORKFLOW_BOUNDARY) {
        const outgoing = outgoingByNode.get(edge.sourceNodeId) ?? [];
        outgoing.push(edge);
        outgoingByNode.set(edge.sourceNodeId, outgoing);
      }
    }

    // ------------------------------------------------------------------
    // Stage 6 — connection policies and counts.
    // ------------------------------------------------------------------
    this.connectionPolicyValidator.validate({ edges, nodeById }, issues);

    // ------------------------------------------------------------------
    // Stage 7 — topology (acyclicity, binding satisfaction, required-value
    // satisfiability). Loop-body graphs are validated recursively at stage 1
    // and are therefore independently acyclic.
    // ------------------------------------------------------------------
    this.validateAcyclicity(resolvedNodes, edges, document, issues);
    collectLooseNodeIssues(document, issues);
    for (const node of resolvedNodes) {
      this.parameterValidator.validateBindingSatisfaction(
        node.instance,
        node.manifest,
        incomingByNode.get(node.instance.id) ?? [],
        issues,
        `nodes[${node.instance.id}]`,
        { allowLiteralAndEdgeBindings: this.options.allowLiteralAndEdgeBindings }
      );
    }
    this.validateRequiredWorkflowOutputs(document, outgoingByNode, issues);

    // ------------------------------------------------------------------
    // Stage 8 — credential-reference authorization.
    // ------------------------------------------------------------------
    for (const node of resolvedNodes) {
      await this.credentialValidator.validate(
        node.instance,
        node.manifest,
        issues,
        `nodes[${node.instance.id}]`
      );
    }

    // ------------------------------------------------------------------
    // Stage 9 — capability validation.
    // ------------------------------------------------------------------
    this.validateCapabilities(resolvedNodes, issues);

    if (issues.length > 0) {
      return { valid: false, issues };
    }

    const resolved: GraphResolvedWorkflow = {
      document,
      nodes: resolvedNodes,
      edges,
      nodeById,
      incomingByNode,
      outgoingByNode,
    };
    return { valid: true, issues, resolved };
  }

  /**
   * Stage 1 — document structure. Returns `true` when the document is
   * structurally sound enough to continue (shape and JSON safety are
   * hard preconditions); all other findings accumulate as issues.
   */
  private async validateStructure(
    document: GraphWorkflowDocument,
    limits: Required<GraphWorkflowDocumentValidationLimits>,
    depth: number,
    issues: GraphValidationIssue[],
    ...args: MaybeContextualArg<Context>
  ): Promise<boolean> {
    if (!isGraphWorkflowDocumentShape(document)) {
      issues.push({
        code: "document.shape",
        path: "$",
        message:
          "Payload is not a canonical GraphWorkflowDocument: id and name must be strings and inputs, outputs, nodes and edges must be arrays",
      });
      return false;
    }

    if (!document.id || !document.id.trim()) {
      issues.push({
        code: "document.empty-id",
        path: "$.id",
        message: "Workflow document id must be a non-empty string",
      });
    }

    if (!isGraphJsonSafeValue(document)) {
      issues.push({
        code: "document.json-unsafe",
        path: "$",
        message:
          "Document contains JSON-unsafe values: functions, class instances, undefined, NaN/Infinity, symbol keys and unsafe prototype keys are rejected",
      });
      return false;
    }

    // Forbidden fields (raw definitions/executors must never enter planning).
    issues.push(
      ...forbiddenFieldIssues(document as unknown as Record<string, unknown>, "$")
    );
    for (const port of [...document.inputs, ...document.outputs]) {
      issues.push(
        ...forbiddenFieldIssues(port as unknown as Record<string, unknown>, "ports")
      );
    }
    for (const node of document.nodes) {
      issues.push(
        ...forbiddenFieldIssues(
          node as unknown as Record<string, unknown>,
          `nodes[${node.id}]`
        )
      );
    }
    for (const edge of document.edges) {
      issues.push(
        ...forbiddenFieldIssues(edge as unknown as Record<string, unknown>, `edges[${edge.id}]`)
      );
    }

    this.validateUniqueIds(document, issues);
    this.validateLimits(document, limits, depth, issues);

    try {
      assertGraphWorkflowDocumentValid(document);
    } catch (e: unknown) {
      issues.push({
        code: "document.structure",
        path: "$",
        message: e instanceof Error ? e.message : String(e),
      });
    }

    // Recursive nested-workflow validation: every loop body is itself a
    // canonical document and runs through the same nine stages.
    await this.validateNestedBodies(document, depth, issues, ...args);

    return true;
  }

  /**
   * Stage 1 — unique node, edge, workflow-input and workflow-output ids.
   */
  private validateUniqueIds(
    document: GraphWorkflowDocument,
    issues: GraphValidationIssue[]
  ): void {
    const inputIds = new Set<string>();
    const outputIds = new Set<string>();
    for (const [scope, ports] of [
      ["input", document.inputs],
      ["output", document.outputs],
    ] as const) {
      const seen = scope === "input" ? inputIds : outputIds;
      for (const port of ports as GraphWorkflowPortInstance[]) {
        if (seen.has(port.id)) {
          issues.push({
            code: "document.duplicate-port-id",
            path: `${scope === "input" ? "inputs" : "outputs"}[${port.id}]`,
            message: `Workflow ${scope} port '${port.id}' is declared more than once; workflow port ids must be unique`,
          });
        } else {
          seen.add(port.id);
        }
      }
    }

    const nodeIds = new Set<string>();
    for (const node of document.nodes) {
      if (nodeIds.has(node.id)) {
        issues.push({
          code: "document.duplicate-node-id",
          path: `nodes[${node.id}]`,
          message: `Node '${node.id}' is declared more than once; node ids must be unique`,
          nodeId: node.id,
        });
      } else {
        nodeIds.add(node.id);
      }
    }

    const edgeIds = new Set<string>();
    for (const edge of document.edges) {
      if (edgeIds.has(edge.id)) {
        issues.push({
          code: "document.duplicate-edge-id",
          path: `edges[${edge.id}]`,
          message: `Edge '${edge.id}' is declared more than once; edge ids must be unique`,
          edgeId: edge.id,
        });
      } else {
        edgeIds.add(edge.id);
      }
    }
  }

  /**
   * Stage 1 — backend-enforced configurable limits: document size, nesting
   * depth, node count, edge count.
   */
  private validateLimits(
    document: GraphWorkflowDocument,
    limits: Required<GraphWorkflowDocumentValidationLimits>,
    depth: number,
    issues: GraphValidationIssue[]
  ): void {
    if (document.nodes.length > limits.maxNodes) {
      issues.push({
        code: "document.limit.nodes",
        path: "$.nodes",
        message: `Document declares ${document.nodes.length} nodes; at most ${limits.maxNodes} are allowed`,
        details: { count: document.nodes.length, limit: limits.maxNodes },
      });
    }
    if (document.edges.length > limits.maxEdges) {
      issues.push({
        code: "document.limit.edges",
        path: "$.edges",
        message: `Document declares ${document.edges.length} edges; at most ${limits.maxEdges} are allowed`,
        details: { count: document.edges.length, limit: limits.maxEdges },
      });
    }
    if (depth > limits.maxNestingDepth) {
      issues.push({
        code: "document.limit.depth",
        path: "$",
        message: `Document nests loop bodies ${depth} levels deep; at most ${limits.maxNestingDepth} levels are allowed`,
        details: { depth, limit: limits.maxNestingDepth },
      });
    }
    const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
    if (bytes > limits.maxDocumentBytes) {
      issues.push({
        code: "document.limit.size",
        path: "$",
        message: `Document serializes to ${bytes} bytes; at most ${limits.maxDocumentBytes} bytes are allowed`,
        details: { bytes, limit: limits.maxDocumentBytes },
      });
    }
  }

  /**
   * Stage 1 — recursive nested-workflow validation. Every loop body runs
   * through the full nine-stage gate; nested issues are merged with a path
   * prefix identifying the owning loop node.
   */
  private async validateNestedBodies(
    document: GraphWorkflowDocument,
    depth: number,
    issues: GraphValidationIssue[],
    ...args: MaybeContextualArg<Context>
  ): Promise<void> {
    for (const node of document.nodes) {
      const bodies: Array<[string, GraphWorkflowDocument | undefined]> = [
        ["loop.body", node.loop?.body],
        ["errorBoundary.try", node.errorBoundary?.try],
        ["errorBoundary.catch", node.errorBoundary?.catch],
        ["errorBoundary.finally", node.errorBoundary?.finally],
      ];
      for (const [label, body] of bodies) {
        if (!body) continue;
        const nested = await this.validate(body, depth + 1, ...args);
        for (const issue of nested.issues) {
          issues.push({
            ...issue,
            path: `nodes[${node.id}].${label}.${issue.path}`,
            nodeId: issue.nodeId ?? node.id,
          });
        }
      }
    }
  }

  /**
   * Stage 7 — acyclicity (DECAF-32 preserved). Kahn's algorithm over the
   * resolved executable nodes; connection and data edges both count as
   * dependencies. Loop constructs are excepted because their bodies are
   * separate nested documents, validated recursively.
   */
  private validateAcyclicity(
    nodes: GraphResolvedNodeInstance[],
    edges: GraphResolvedEdgeInstance[],
    document: GraphWorkflowDocument,
    issues: GraphValidationIssue[]
  ): void {
    const nodeIds = new Set(nodes.map((node) => node.instance.id));
    const indegree = new Map<string, number>(
      nodes.map((node) => [node.instance.id, 0])
    );
    for (const edge of edges) {
      if (
        nodeIds.has(edge.sourceNodeId) &&
        indegree.has(edge.targetNodeId)
      ) {
        indegree.set(
          edge.targetNodeId,
          (indegree.get(edge.targetNodeId) ?? 0) + 1
        );
      }
    }

    const queue = [...indegree.entries()]
      .filter(([, degree]) => degree === 0)
      .map(([id]) => id);
    const ordered: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      ordered.push(current);
      for (const edge of edges) {
        if (edge.sourceNodeId !== current) continue;
        if (!indegree.has(edge.targetNodeId)) continue;
        const degree = (indegree.get(edge.targetNodeId) ?? 1) - 1;
        indegree.set(edge.targetNodeId, degree);
        if (degree === 0) queue.push(edge.targetNodeId);
      }
    }

    if (ordered.length !== indegree.size) {
      const cyclic = [...indegree.keys()].filter((id) => !ordered.includes(id));
      issues.push({
        code: "topology.cycle",
        path: "$.edges",
        message: `Workflow '${document.id}' contains an unsupported cycle involving node(s): ${cyclic.join(", ")}`,
        details: { cyclicNodes: cyclic },
      });
    }
  }

  /**
   * Stage 7 — required values must be satisfiable: every required workflow
   * output port must be routable from at least one node output.
   */
  private validateRequiredWorkflowOutputs(
    document: GraphWorkflowDocument,
    outgoingByNode: Map<string, GraphResolvedEdgeInstance[]>,
    issues: GraphValidationIssue[]
  ): void {
    const routedOutputs = new Set<string>();
    for (const edges of outgoingByNode.values()) {
      for (const edge of edges) {
        if (edge.targetNodeId === GRAPH_WORKFLOW_BOUNDARY) {
          routedOutputs.add(edge.targetPort);
        }
      }
    }
    for (const port of document.outputs) {
      if (port.required !== true) continue;
      if (port.defaultValue !== undefined) continue;
      if (!routedOutputs.has(port.id)) {
        issues.push({
          code: "topology.required-output-unsatisfiable",
          path: `outputs[${port.id}]`,
          message: `Required workflow output '${port.id}' has no incoming edge from any node`,
        });
      }
    }
  }

  /**
   * Stage 9 — capability validation. Declared manifest capabilities must be
   * known values, and document features that require a capability may only be
   * used on kinds declaring it (loop configuration requires the `loop`
   * capability). Lenient transition manifests (legacy executor-only
   * registrations) are exempt until cutover (§4.18).
   */
  private validateCapabilities(
    nodes: GraphResolvedNodeInstance[],
    issues: GraphValidationIssue[]
  ): void {
    for (const node of nodes) {
      const manifest: GraphResolvedNodeManifest = node.manifest;
      for (const capability of manifest.capabilities ?? []) {
        if (!isGraphNodeCapability(capability)) {
          issues.push({
            code: "capability.invalid",
            path: `nodes[${node.instance.id}]`,
            message: `Kind '${manifest.kind}' declares unknown capability '${String(capability)}'`,
            nodeId: node.instance.id,
            details: { capability: String(capability) },
          });
        }
      }
      if (manifest.policies?.allowUndeclaredParameters === true) continue;
      if (node.instance.loop) {
        const hasLoopCapability = (manifest.capabilities ?? []).includes("loop");
        if (!hasLoopCapability) {
          issues.push({
            code: "capability.loop-not-supported",
            path: `nodes[${node.instance.id}].loop`,
            message: `Node '${node.instance.id}' carries loop configuration but kind '${manifest.kind}' does not declare the 'loop' capability`,
            nodeId: node.instance.id,
          });
        }
      }
    }
  }
}
