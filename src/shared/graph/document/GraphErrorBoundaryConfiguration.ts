import type { GraphWorkflowDocument } from "./GraphWorkflowDocument";

/**
 * Error-boundary body configuration (DECAF-50 §4.5): the guarded `try`
 * workflow document plus the optional `catch` and `finally` bodies.
 *
 * The engine executes `try`; a failure routes to `catch` (when declared) and
 * the boundary emits the `error` output. When `try` succeeds the boundary
 * emits the `result` output. The `finally` body, when declared, always runs.
 */
export interface GraphErrorBoundaryConfiguration {
  try: GraphWorkflowDocument;
  catch?: GraphWorkflowDocument;
  finally?: GraphWorkflowDocument;
}
