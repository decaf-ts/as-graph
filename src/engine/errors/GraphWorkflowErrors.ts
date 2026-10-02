import { ValidationError } from "@decaf-ts/db-decorators";
import type { GraphValidationIssue } from "../validation/GraphValidationIssue";

/**
 * Raised when a submitted workflow document fails boundary validation and
 * must not be persisted (DECAF-50 §4.10). Carries the structured issues so
 * HTTP transports can surface them without re-running validation.
 *
 * @class GraphWorkflowDocumentRejectedError
 */
export class GraphWorkflowDocumentRejectedError extends ValidationError {
  /** Structured validation issues that caused the rejection. */
  readonly issues: GraphValidationIssue[];

  constructor(issues: GraphValidationIssue[]) {
    super(
      `Graph workflow document rejected with ${issues.length} issue(s): ${issues
        .map((i) => `${i.code} at ${i.path} (${i.message})`)
        .join("; ")}`
    );
    this.name = GraphWorkflowDocumentRejectedError.name;
    this.issues = issues;
  }
}
