/**
 * @module as-graph/engine/validation/GraphValidationErrors
 * @summary Normative validation error hierarchy for graph modules (DECAF-50 §4.8).
 * @description Decaf error hierarchy ONLY (constitution §1.1.3): these errors
 * extend the base Decaf errors, never raw `Error`. They are thrown for
 * fail-fast paths (e.g. the engine refusing to execute an invalid document);
 * the nine-stage validator itself accumulates structured
 * {@link GraphValidationIssue}s instead of throwing.
 */
import { AuthorizationError } from "@decaf-ts/core";
import { ValidationError } from "@decaf-ts/db-decorators";

import type { GraphValidationIssue } from "./GraphValidationIssue";

/**
 * Thrown when a workflow document is structurally or semantically invalid.
 * Carries the structured issues found by the nine-stage validator.
 */
export class GraphDocumentValidationError extends ValidationError {
  readonly issues: GraphValidationIssue[];

  constructor(message: string, issues: GraphValidationIssue[] = []) {
    super(message);
    this.issues = issues;
    this.name = GraphDocumentValidationError.name;
  }
}

/**
 * Thrown when an edge violates connection-policy rules.
 */
export class GraphConnectionValidationError extends ValidationError {
  readonly edgeId?: string;

  constructor(message: string, edgeId?: string) {
    super(message);
    this.edgeId = edgeId;
    this.name = GraphConnectionValidationError.name;
  }
}

/**
 * Thrown when a credential reference fails existence, authorization, or
 * type-match checks.
 */
export class GraphCredentialAuthorizationError extends AuthorizationError {
  constructor(message: string) {
    super(message);
    this.name = GraphCredentialAuthorizationError.name;
  }
}
