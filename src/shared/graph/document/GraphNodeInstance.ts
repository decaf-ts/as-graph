import type { GraphErrorBoundaryConfiguration } from "./GraphErrorBoundaryConfiguration";
import type { GraphInputBinding, GraphOutputBinding } from "./GraphNodeBinding";
import type { GraphJsonValue } from "./GraphJsonValue";
import type { GraphLoopConfiguration } from "./GraphLoopConfiguration";
import type { GraphNodeUiState } from "./GraphWorkflowUiState";

/**
 * Document-carried UI data-pinning state (D4, DECAF-50 §4.22). Data pinning
 * freezes the node's parameter values so downstream runs reuse them, and is a
 * distinct concept from the engine's cache pinning (`GraphPinning`): this state is
 * written into the canonical document and survives save/load round-trips.
 */
export interface GraphNodePinState {
  /**
   * Parameter values frozen when the node was pinned. Downstream runs apply this
   * snapshot on top of the node's live parameters.
   */
  parameters: Record<string, GraphJsonValue>;
  /** ISO-8601 timestamp of when the pin was captured, when known. */
  pinnedAt?: string;
}

/**
 * Canonical node instance in a workflow document (DECAF-50 §4.5).
 */
export interface GraphNodeInstance {
  id: string;
  kind: string;
  label?: string;
  parameters: Record<string, GraphJsonValue>;
  inputBindings?: Record<string, GraphInputBinding>;
  outputBindings?: Record<string, GraphOutputBinding>;
  disabled?: boolean;
  metadata?: Record<string, GraphJsonValue>;
  /**
   * Persisted, user-defined node internal state (DECAF-50 §4.5, item 3).
   *
   * Declared on the node class with `@state({ schema, defaultValue })` and
   * folded into the document by the builder (class defaults or instance values)
   * and the decorated compiler. Unlike `parameters` (I/O port values) and
   * `metadata` (editor/display data), `state` is hydrated back onto the node
   * instance by `graphNodeConfig` (merge order `metadata` → `parameters` →
   * `state`, state last) so `execute` reads it via `this.*`.
   */
  state?: Record<string, GraphJsonValue>;
  loop?: GraphLoopConfiguration;
  errorBoundary?: GraphErrorBoundaryConfiguration;
  ui?: GraphNodeUiState;
  /**
   * UI data-pinning state (D4, DECAF-50 §4.22). Present iff the node is
   * pinned; the frozen parameter snapshot is what downstream runs reuse.
   */
  pinned?: GraphNodePinState;
}
