/**
 * @module as-graph/engine/validation/GraphValidationIssue
 * @summary Structured workflow-document validation issues (DECAF-50 §4.8).
 * @description Structured issue accumulation for the nine-stage backend
 * workflow validation gate. Validators record {@link GraphValidationIssue}s
 * instead of failing abruptly; a completed
 * {@link GraphWorkflowValidationResult} carries every issue found plus, when
 * valid, the resolved workflow consumed by the planner.
 */
import type { GraphJsonValue } from "../../shared/graph";

import type { GraphResolvedWorkflow } from "./GraphResolvedWorkflow";

/**
 * A single validation finding for a workflow document.
 */
export interface GraphValidationIssue {
  /** Stable machine-readable issue code (e.g. `kind.unknown`). */
  code: string;
  /** Dotted path to the offending part of the document. */
  path: string;
  /** Human-readable description of the issue. */
  message: string;
  /** Node instance the issue refers to, when applicable. */
  nodeId?: string;
  /** Edge instance the issue refers to, when applicable. */
  edgeId?: string;
  /** Safe extra context (JSON values only — never credentials). */
  details?: Record<string, GraphJsonValue>;
}

/**
 * Result of validating (and, when valid, resolving) a workflow document.
 */
export interface GraphWorkflowValidationResult {
  /** `true` when the document passed all nine validation stages. */
  valid: boolean;
  /** Every issue found, in normative stage order 1→9. */
  issues: GraphValidationIssue[];
  /** The resolved workflow, present when `valid` is `true`. */
  resolved?: GraphResolvedWorkflow;
}
