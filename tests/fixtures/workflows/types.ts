/**
 * @module as-graph/tests/fixtures/workflows/types
 * @summary Types for the persisted demo workflow fixture registry (SAA-2049).
 */
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import type { GraphExecutionValues } from "../../../src/engine/types";

/**
 * The six node-configuration combinations the fixture set must cover
 * (SAA-2049 §2).
 */
export type GraphConfigCombo =
  | "straight-value"
  | "code-expression"
  | "text-template"
  | "exposed-ports"
  | "user-controlled-properties"
  | "defaults";

/**
 * A persisted demo workflow fixture and its execution expectations.
 */
export interface GraphWorkflowFixture {
  /** Stable fixture/workflow id. */
  id: string;
  /** The canonical persisted document. */
  document: GraphWorkflowDocument;
  /** Built-in node kinds the workflow exercises. */
  kinds: string[];
  /** Config combos the workflow exercises. */
  combos: GraphConfigCombo[];
  /** Whether the real engine can execute the fixture end to end. */
  executable: boolean;
  /** Why a non-executable fixture cannot run (production gap). */
  skipReason?: string;
  /** Inputs passed to `GraphExecutionEngine.execute`. */
  inputs?: GraphExecutionValues;
  /** Partial expected workflow outputs. */
  expectedOutputs?: Record<string, unknown>;
}
