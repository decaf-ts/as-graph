import type { GraphJsonValue } from "./GraphJsonValue";
import { isGraphUnsafeObjectKey } from "./GraphJsonValue";
import type {
  GraphWorkflowDocument,
  GraphWorkflowPortInstance,
} from "./GraphWorkflowDocument";
import { isGraphWorkflowDocumentShape } from "./GraphWorkflowDocument";
import type { GraphNodeInstance } from "./GraphNodeInstance";
import type { GraphEdgeInstance } from "./GraphEdgeInstance";
import type {
  GraphNodeUiState,
  GraphWorkflowUiState,
} from "./GraphWorkflowUiState";

/**
 * Returns the value as a {@link GraphWorkflowDocument} when it has the canonical shape.
 */
export function graphWorkflowDocumentOf(
  value: unknown
): GraphWorkflowDocument | undefined {
  if (!isGraphWorkflowDocumentShape(value)) return undefined;
  return value as unknown as GraphWorkflowDocument;
}

/**
 * Returns the document node with `nodeId`, when present.
 */
export function graphWorkflowNodeOf(
  document: GraphWorkflowDocument | undefined,
  nodeId: string
): GraphNodeInstance | undefined {
  return document?.nodes.find((node) => node.id === nodeId);
}

/**
 * Returns the document edge with `edgeId`, when present.
 */
export function graphWorkflowEdgeOf(
  document: GraphWorkflowDocument | undefined,
  edgeId: string
): GraphEdgeInstance | undefined {
  return document?.edges.find((edge) => edge.id === edgeId);
}

/**
 * Returns the document's workflow input and output ports.
 */
export function graphWorkflowPortsOf(
  document: GraphWorkflowDocument | undefined
): { inputs: GraphWorkflowPortInstance[]; outputs: GraphWorkflowPortInstance[] } {
  const inputs = document?.inputs ?? [];
  const outputs = document?.outputs ?? [];
  return { inputs, outputs };
}

/**
 * Returns a copy of the document's settings map.
 */
export function graphWorkflowSettingsOf(
  document: GraphWorkflowDocument | undefined
): Record<string, GraphJsonValue> {
  return { ...(document?.settings ?? {}) };
}

/**
 * Returns the document's edges.
 */
export function graphWorkflowEdgesOf(
  document: GraphWorkflowDocument | undefined
): GraphEdgeInstance[] {
  return document?.edges ?? [];
}

/**
 * Returns every edge touching `nodeId`.
 */
export function graphWorkflowNodeEdgesOf(
  document: GraphWorkflowDocument | undefined,
  nodeId: string
): GraphEdgeInstance[] {
  return (document?.edges ?? []).filter(
    (edge) => graphNodeEndpointId(edge.source) === nodeId || graphNodeEndpointId(edge.target) === nodeId
  );
}

/**
 * Returns the node id of a node-scoped endpoint, or `undefined` for workflow endpoints.
 *
 * @param {object} endpoint - The edge endpoint to inspect.
 */
export function graphNodeEndpointId(
  endpoint: GraphEdgeInstance["source"]
): string | undefined {
  if (endpoint && (endpoint as Record<string, unknown>).scope === "node") {
    return (endpoint as { nodeId: string }).nodeId;
  }
  return undefined;
}

/**
 * Returns the UI state of the node with `nodeId`, when present.
 */
export function graphWorkflowNodeUiOf(
  document: GraphWorkflowDocument,
  nodeId: string
): GraphNodeUiState | undefined {
  return graphWorkflowNodeOf(document, nodeId)?.ui;
}

/**
 * Returns the workflow-level UI state, when present.
 */
export function graphWorkflowUiOf(
  document: GraphWorkflowDocument
): GraphWorkflowUiState | undefined {
  return document.ui ?? undefined;
}

/**
 * Returns a workflow UI-state value by key, guarding against unsafe keys.
 */
export function graphWorkflowUiValueOf(
  document: GraphWorkflowDocument,
  key: string
): GraphJsonValue | undefined {
  const ui = graphWorkflowUiOf(document);
  if (!ui || isGraphUnsafeObjectKey(key)) return undefined;
  return ui[key];
}

/**
 * Returns a workflow setting by key, guarding against unsafe keys.
 */
export function graphWorkflowDocumentSettingOf(
  document: GraphWorkflowDocument | undefined,
  key: string
): GraphJsonValue | undefined {
  return hasSetting(document?.settings, key)
    ? (document!.settings as Record<string, GraphJsonValue>)[key]
    : undefined;
}

/**
 * Returns a document metadata value by key, guarding against unsafe keys.
 */
export function graphWorkflowDocumentMetadataValueOf(
  document: GraphWorkflowDocument | undefined,
  key: string
): GraphJsonValue | undefined {
  if (
    !document?.metadata ||
    isGraphUnsafeObjectKey(key) ||
    !(key in document.metadata)
  ) {
    return undefined;
  }
  return document.metadata[key];
}

function hasSetting(
  settings: GraphWorkflowDocument["settings"] | undefined,
  key: string
): boolean {
  return Boolean(settings) && !isGraphUnsafeObjectKey(key) && key in (settings as object);
}
