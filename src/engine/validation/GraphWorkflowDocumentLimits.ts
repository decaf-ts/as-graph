/**
 * Backend-enforced, configurable resource limits for canonical workflow
 * documents submitted at the persistence boundary (DECAF-50 §4.16).
 *
 * Defaults (technical governance delegates the numbers to implementation):
 * - `maxDocumentBytes: 2_000_000` — a full canonical document serializes to
 *   well under 2 MB for realistic graphs; the cap blocks oversized payloads
 *   before deep validation runs.
 * - `maxNestingDepth: 10` — nested loop bodies are themselves documents; ten
 *   levels of nesting is far beyond any sane workflow while keeping recursive
 *   validation cheap.
 * - `maxNodes: 500` — per document level (nested loop bodies are limited
 *   independently), generous for editor-built graphs.
 * - `maxEdges: 1_000` — roughly twice the node cap, matching typical
 *   fan-out without enabling quadratic edge bombs.
 *
 * Every limit is enforced backend-side before persistence and can be
 * overridden through `GraphExecutionModuleOptions.workflows.limits`.
 *
 * @module as-graph/engine/validation/GraphWorkflowDocumentLimits
 */
export interface GraphWorkflowDocumentLimits {
  /** Maximum serialized size of the document in bytes. */
  maxDocumentBytes?: number;
  /** Maximum nested loop-body document depth (root document is depth 0). */
  maxNestingDepth?: number;
  /** Maximum node instances per document level. */
  maxNodes?: number;
  /** Maximum edge instances per document level. */
  maxEdges?: number;
}

/** Default document resource limits (§4.16): payload size, nesting depth, node and edge counts. */
export const DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS: Required<GraphWorkflowDocumentLimits> =
  {
    maxDocumentBytes: 2_000_000,
    maxNestingDepth: 10,
    maxNodes: 500,
    maxEdges: 1_000,
  };
