/**
 * Execution-policy facet of a node manifest (DECAF-50 §4.9/§4.12): the
 * declarative limits the run engine enforces for a node kind — manual
 * triggering, retries, cancellation, timeouts, concurrency, and input
 * binding mode. Carried inside {@link GraphNodeManifest} and mirrored by the
 * backend catalogue; transition-leniency flags are stripped at cutover (P7).
 */
export interface GraphNodePolicyManifest {
  /** Whether and when the node may be triggered manually (`"partial"` defers to port-level rules). */
  allowManualTrigger?: "always" | "never" | "partial";
  /** Whether failed node executions may be retried. */
  allowRetry?: boolean;
  /** Maximum number of retry attempts when {@link GraphNodePolicyManifest.allowRetry} is enabled. */
  maxRetries?: number;
  /** Whether an in-flight node execution may be cancelled. */
  allowCancel?: boolean;
  /** Execution timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum number of concurrent executions allowed for the node. */
  concurrency?: number;
  /** How many input bindings the node accepts per input port. */
  inputMode?: GraphNodePolicyInputMode;
  /**
   * Transition leniency (DECAF-50 §4.8/§4.18): when `true`, document
   * validation accepts parameters that are not declared by the manifest.
   * Set on placeholder manifests created for legacy executor-only
   * registrations; removed at cutover (P7).
   */
  allowUndeclaredParameters?: boolean;
  /**
   * Transition leniency (DECAF-50 §4.9): when `true`, executor outputs that
   * are not declared by the effective output manifest are accepted instead
   * of being rejected. Set on placeholder manifests; removed at cutover (P7).
   */
  allowUnknownOutputs?: boolean;
}

/** Input binding mode of a node policy: any number of bindings, exactly one, or multiple. */
export type GraphNodePolicyInputMode = "any" | "single" | "multiple";

/**
 * Type guard for {@link GraphNodePolicyManifest}: accepts objects whose
 * `inputMode` (when present) is one of the declared
 * {@link GraphNodePolicyInputMode} values.
 *
 * @returns {boolean} Whether the value is a {@link GraphNodePolicyManifest}.
 */
export function isGraphNodePolicyManifest(value: unknown): value is GraphNodePolicyManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const mode = (value as Record<string, unknown>)["inputMode"];
  return mode === undefined || mode === "any" || mode === "single" || mode === "multiple";
}
