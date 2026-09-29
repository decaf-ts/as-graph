import type { GraphWorkflowDocument } from "./document/GraphWorkflowDocument";
import type { GraphJsonValue } from "./document/GraphJsonValue";

/**
 * Editor-only state that the canonical {@link GraphWorkflowDocument} cannot
 * express (layout beyond node positions, config-store values, per-port modes,
 * workflow boundary values, and duplicate counts). Stored as JSON-safe values
 * only; constructors and `modelClass`/`sourceClass` references are dropped.
 */
export type GraphSnapshotEditorState = {
  viewport?: { x: number; y: number; scale: number };
  duplicateCounts?: Record<string, number>;
  boundaryInputValues?: Record<string, GraphJsonValue>;
  boundaryOutputValues?: Record<string, GraphJsonValue>;
  nodePorts?: Record<string, Record<string, GraphJsonValue>>;
  nodeConfigs?: Record<string, GraphJsonValue>;
  diagramMetadata?: Record<string, GraphJsonValue>;
  definitionDisplay?: Record<string, GraphJsonValue>;
} & { [key: string]: GraphJsonValue | undefined };

/**
 * Canonical document-first snapshot. `document` is the executable semantic
 * truth; `editor` preserves editor-only UI state. This is the only persisted and
 * executed snapshot form (DECAF-50 §4.26 R2-2): the engine ships as its first
 * version with no backward compatibility, so the former
 * `{ definition, state }` legacy snapshot and its conversion helpers are gone.
 */
export type GraphWorkflowSnapshot = {
  document: GraphWorkflowDocument;
  editor?: GraphSnapshotEditorState;
  metadata?: Record<string, GraphJsonValue>;
};
