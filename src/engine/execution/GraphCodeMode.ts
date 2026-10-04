/**
 * @module as-graph/execution/GraphCodeMode
 * @summary Code-mode surface detection for the pluggable backend gate (SAA-193 C1).
 * @description The security gate requires the facade to detect every code-mode
 * surface in a workflow before delegating to a non-local backend, so it can fail
 * closed instead of launching a remote run that cannot execute it. This module is
 * the single detection authority. It walks the canonical
 * {@link GraphWorkflowDocument} and reports every surface the reference engine
 * would evaluate through the code sandbox:
 *
 * - a `CodeCondition` (`{ type: "code" }`) on any flow-control carrier —
 *   if / elseIf / while / until conditions and switch-case conditions, in either
 *   the `parameters` or the `metadata` carrier;
 * - a `core.utility.code` node;
 * - a `GraphValueTemplate` parameter;
 * - an expression input binding (`mode: "expression"`) and an expression
 *   {@link GraphValueReference} in a loop input/output mapping.
 *
 * Nested loop-body documents are scanned recursively, so a code-mode surface
 * buried inside a loop body is caught before any remote launch.
 */
import type {
  GraphNodeInstance,
  GraphWorkflowDocument,
} from "../../shared/graph";
import { isGraphValueTemplate } from "../../shared/graph";
import { isCodeCondition } from "../loops/ConditionEvaluator";

/**
 * The kind of code-mode surface detected in a workflow document.
 */
export type GraphCodeModeSurfaceKind =
  | "code-condition"
  | "code-node"
  | "value-template"
  | "expression-binding";

/**
 * A single code-mode surface found in a workflow document.
 */
export interface GraphCodeModeSurface {
  /** The node carrying the surface. */
  nodeId: string;
  /** The kind of surface detected. */
  kind: GraphCodeModeSurfaceKind;
  /** Optional carrier detail (e.g. the bound input port). */
  detail?: string;
}

/** The node kind whose executor runs user code in the sandbox. */
const GRAPH_CODE_NODE_KIND = "core.utility.code";

/**
 * Detects whether a value is a loop `GraphValueReference` expression
 * (`{ source: "expression", expression }`), which the sandbox evaluates.
 *
 * @returns {boolean} Whether `value` is an expression value reference.
 */
function isGraphExpressionValueReference(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record["source"] === "expression" &&
    typeof record["expression"] === "string"
  );
}

/**
 * Detects whether a value has the canonical workflow-document shape, so nested
 * loop-body documents are scanned recursively.
 *
 * @returns {boolean} Whether `value` looks like a workflow document.
 */
function isWorkflowDocumentLike(
  value: unknown
): value is GraphWorkflowDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["name"] === "string" &&
    Array.isArray(record["nodes"]) &&
    Array.isArray(record["edges"])
  );
}

/**
 * Recursively scans a value for code-mode surfaces, recording each one once.
 *
 * @param value - The value to scan.
 * @param nodeId - The owning node id used for reporting.
 * @param surfaces - The accumulator.
 * @param seen - Cycle guard for shared/cyclic object graphs.
 */
function scanCodeModeValue(
  value: unknown,
  nodeId: string,
  surfaces: GraphCodeModeSurface[],
  seen: Set<unknown>
): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (isCodeCondition(value)) {
    surfaces.push({ nodeId, kind: "code-condition" });
    return;
  }
  if (isGraphValueTemplate(value)) {
    surfaces.push({ nodeId, kind: "value-template" });
    return;
  }
  if (isGraphExpressionValueReference(value)) {
    surfaces.push({ nodeId, kind: "expression-binding" });
    return;
  }
  if (isWorkflowDocumentLike(value)) {
    scanCodeModeDocument(value, surfaces, seen);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      scanCodeModeValue(item, nodeId, surfaces, seen);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    scanCodeModeValue(
      (value as Record<string, unknown>)[key],
      nodeId,
      surfaces,
      seen
    );
  }
}

/**
 * Scans a single node instance for code-mode surfaces across every carrier:
 * its kind, input bindings, parameters, metadata, persisted state, and loop
 * configuration (condition, mappings, and nested body document).
 *
 * @param node - The canonical node instance to scan.
 * @param surfaces - The accumulator.
 * @param seen - Cycle guard for shared/cyclic object graphs.
 */
function scanCodeModeNode(
  node: GraphNodeInstance,
  surfaces: GraphCodeModeSurface[],
  seen: Set<unknown>
): void {
  const nodeId = node.id;
  if (node.kind === GRAPH_CODE_NODE_KIND) {
    surfaces.push({ nodeId, kind: "code-node", detail: node.kind });
  }
  const bindings = node.inputBindings ?? {};
  for (const [port, binding] of Object.entries(bindings)) {
    if (
      binding &&
      (binding as { mode?: unknown }).mode === "expression"
    ) {
      surfaces.push({ nodeId, kind: "expression-binding", detail: port });
    }
  }
  scanCodeModeValue(node.parameters, nodeId, surfaces, seen);
  scanCodeModeValue(node.metadata, nodeId, surfaces, seen);
  scanCodeModeValue(node.state, nodeId, surfaces, seen);
  scanCodeModeValue(node.loop, nodeId, surfaces, seen);
}

/**
 * Scans every node of a workflow document, including nested loop bodies.
 *
 * @param document - The canonical document to scan.
 * @param surfaces - The accumulator.
 * @param seen - Cycle guard for shared/cyclic object graphs.
 */
function scanCodeModeDocument(
  document: GraphWorkflowDocument,
  surfaces: GraphCodeModeSurface[],
  seen: Set<unknown>
): void {
  for (const node of document.nodes ?? []) {
    scanCodeModeNode(node, surfaces, seen);
  }
}

/**
 * Detects every code-mode surface in a canonical workflow document (SAA-193 C1).
 *
 * @param document - The canonical document to inspect.
 * @returns One entry per code-mode surface found; empty when the workflow is
 *   fully graphical and host-executable.
 */
export function detectGraphCodeModeSurfaces(
  document: GraphWorkflowDocument
): GraphCodeModeSurface[] {
  const surfaces: GraphCodeModeSurface[] = [];
  scanCodeModeDocument(document, surfaces, new Set<unknown>());
  return surfaces;
}

/**
 * Reports whether a canonical workflow document carries any code-mode surface.
 *
 * @param document - The canonical document to inspect.
 * @returns `true` when at least one code-mode surface is present.
 */
export function graphDocumentHasCodeMode(
  document: GraphWorkflowDocument
): boolean {
  return detectGraphCodeModeSurfaces(document).length > 0;
}
