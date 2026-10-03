/**
 * @module as-graph/nest/graph/servingErrors
 * @summary Server-side error logging for the graph serving controllers.
 * @description Centralizes the server-side handling of an *unmapped*
 * (non-Decaf, non-`HttpException`) failure reaching the graph serving
 * controllers' catch-all error mappers. The client receives a constant generic
 * `500` body ({@link GRAPH_SERVING_INTERNAL_ERROR_MESSAGE}); the underlying
 * error message and stack plus the request correlation ids (`runId` /
 * `workflowId`) are logged server-side only, so adapter internals (connection
 * strings, credentials, table/column names, driver text) never reach the client.
 */
import { Logging } from "@decaf-ts/logging";

/**
 * Constant generic `500` body served for any unmapped graph serving failure.
 * Deliberately static: no dynamic content, no `e.message`, no `String(e)`.
 */
export const GRAPH_SERVING_INTERNAL_ERROR_MESSAGE = "Internal server error";

/** Logger context for the run lifecycle controller's server-side error log. */
export type GraphServingErrorLoggerContext =
  | "GraphRunController"
  | "GraphWorkflowController";

/**
 * Request/run correlation fields attached to a server-side graph serving error
 * log. Only ids the server already resolved are included; the fields are never
 * served to the client.
 */
export interface GraphServingErrorCorrelation {
  /** Run id, when the failing operation was scoped to a run. */
  runId?: string;
  /** Workflow id, when the failing operation was scoped to a workflow. */
  workflowId?: string;
}

/**
 * Logs an unmapped graph serving failure server-side, with the request
 * correlation ids and the underlying error message/stack. The client receives the
 * constant generic {@link GRAPH_SERVING_INTERNAL_ERROR_MESSAGE} instead; this log
 * is the only place the underlying error detail is surfaced.
 *
 * The correlation ids are serialized directly into the log message (via
 * `JSON.stringify`) rather than relying solely on the logger's `meta` channel. The
 * default RAW log pattern has no `{meta}` placeholder, so a `meta`-only
 * correlation would never render under default text logging; inlining it keeps the
 * ids visible under any renderer, and JSON escaping preserves the no-log-injection
 * property.
 *
 * The whole body is guarded so a hostile thrown value (e.g. a throwing `toString`
 * on the caught value) or a logging-infrastructure failure can never make this
 * mapper throw; failures are swallowed because Nest's default handler still answers
 * the constant generic `500` fail-securely.
 *
 * @param {GraphServingErrorLoggerContext} context - Logger context for the controller handling the failure.
 * @param {unknown} e - The caught error that was not mapped to a specific HTTP status.
 * @param {GraphServingErrorCorrelation} correlation - Request correlation ids, when known.
 * @return {void}
 */
export function logUnmappedGraphServingError(
  context: GraphServingErrorLoggerContext,
  e: unknown,
  correlation: GraphServingErrorCorrelation = {}
): void {
  try {
    const error = e instanceof Error ? e : new Error(String(e));
    const meta: Record<string, unknown> = {};
    if (correlation.runId !== undefined) meta.runId = correlation.runId;
    if (correlation.workflowId !== undefined) {
      meta.workflowId = correlation.workflowId;
    }
    const message = Object.keys(meta).length
      ? `Graph request failed with an unmapped error ${JSON.stringify(meta)}`
      : "Graph request failed with an unmapped error";
    Logging.for(context).error(message, error, meta);
  } catch {
    // Never let the mapper itself throw: a hostile thrown value or a logging
    // failure must not escalate past the constant generic 500 response.
  }
}
