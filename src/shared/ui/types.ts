/**
 * @module as-graph/shared/ui/types
 * @summary Framework-neutral view-model contracts for the graph UI.
 * @description The shared, DOM-free projection of the canonical graph
 * manifests, workflow documents and engine run results that a graph UI
 * renders. These are the "node components" and "port elements" contracts
 * consumed by graph UI renderers: a node view carries
 * its display metadata, its effective (static + dynamic) ports and its visual
 * run state; a workflow view carries the nodes, edges and the optional run
 * feedback. Nothing here touches the DOM or the execution engine, so the shared
 * export stays importable from any frontend bundle.
 */
import type {
  GraphExecutionStatus,
  GraphJsonValue,
  GraphPortManifest,
  GraphPortManifestElement,
  GraphValueSchema,
  GraphVisualState,
} from "../graph";

/** Direction of a port as rendered on a node face. */
export type GraphPortViewDirection = "input" | "output" | "connection";

/**
 * View model for a single node port (a "port element" on the node face).
 */
export interface GraphPortView {
  /** Port identifier (the decorated handle). */
  id: string;
  /** Human-readable port label. */
  label: string;
  /** Port direction. */
  direction: GraphPortViewDirection;
  /** Whether the port requires a value. */
  required: boolean;
  /** Whether the port is hidden from the face (canvas-only port). */
  hidden: boolean;
  /** Optional connection category (e.g. `"model"`, `"memory"`). */
  category?: string;
  /** Optional explicit connection handle. */
  handle?: string;
  /** Optional value schema for the port. */
  schema?: GraphValueSchema;
  /** Optional UI element declaration for the port. */
  element?: GraphPortManifestElement;
}

/**
 * View model for a single node on the workflow canvas. Built from a
 * manifest (static or resolved) plus the optional document instance and the
 * optional per-node run result.
 */
export interface GraphNodeView {
  /** Node instance identifier. */
  id: string;
  /** Node kind discriminator. */
  kind: string;
  /** Rendered node label (instance label, else display name). */
  label: string;
  /** Optional rendered description. */
  description?: string;
  /** Display category. */
  category?: string;
  /** Resolved accent colour (manifest display, else category style). */
  color?: string;
  /** Resolved catalogue icon name. */
  icon?: string;
  /** Rendered node width in pixels. */
  width?: number;
  /** Rendered node height in pixels. */
  height?: number;
  /** Rendered node face silhouette. */
  shape?: string;
  /** Rendered node corner radius in pixels. */
  cornerRadius?: number;
  /** Display labels (search/grouping tags). */
  labels: string[];
  /** Effective input ports. */
  inputs: GraphPortView[];
  /** Effective output ports. */
  outputs: GraphPortView[];
  /** Effective connection ports. */
  connections: GraphPortView[];
  /** Declared capabilities. */
  capabilities: string[];
  /** Whether the instance is disabled. */
  disabled: boolean;
  /** Whether the instance's data is pinned. */
  pinned: boolean;
  /** Visual run state (idle when the node has not run). */
  visualState: GraphVisualState;
  /** Overlay style resolved from the visual state. */
  visualStyle: GraphVisualStyleView;
}

/**
 * Framework-neutral visual overlay resolved from a {@link GraphVisualState}
 * (the shared `graphVisualStyleOf` mapping).
 */
export interface GraphVisualStyleView {
  /** Visual state string. */
  state: string;
  /** Optional glow/border colour for the live run-feedback overlay. */
  glow?: string;
  /** Optional opacity for unexecuted/disabled rendering (0..1). */
  opacity?: number;
  /** Optional fill colour when the node is in this state. */
  color?: string;
}

/** A resolved edge endpoint (workflow boundary or node port). */
export interface GraphEndpointView {
  /** Endpoint scope. */
  scope: "workflow" | "node";
  /** Node id when the endpoint is a node port. */
  nodeId?: string;
  /** Port name. */
  port: string;
}

/** View model for a single workflow edge. */
export interface GraphEdgeView {
  /** Edge instance identifier. */
  id: string;
  /** Edge type. */
  type: "data" | "connection";
  /** Resolved source endpoint. */
  source: GraphEndpointView;
  /** Resolved target endpoint. */
  target: GraphEndpointView;
  /** Optional edge label. */
  label?: string;
  /** Visual run state of the edge. */
  visualState: GraphVisualState;
}

/** View model for a workflow boundary port (input or output badge). */
export interface GraphWorkflowPortView {
  /** Port identifier. */
  id: string;
  /** Port label. */
  label: string;
  /** Whether the port is required. */
  required: boolean;
  /** Optional value schema. */
  schema?: GraphValueSchema;
}

/** A run record for one node (inputs/outputs plus run-state feedback). */
export interface GraphNodeRunView {
  /** Node identifier. */
  nodeId: string;
  /** Engine execution status, when known. */
  status?: GraphExecutionStatus | string;
  /** Visual run state derived from the engine signals. */
  visualState: GraphVisualState;
  /** Intermediate inputs the node consumed. */
  inputs: Record<string, unknown>;
  /** Intermediate outputs the node produced. */
  outputs: Record<string, unknown>;
  /** Structured failure payload, when the node failed. */
  error?: { code?: string; message: string };
  /** Whether the node's result came from the engine cache. */
  fromCache: boolean;
  /** Whether the node ran against pinned values. */
  pinned: boolean;
  /** ISO-8601 start timestamp, when known. */
  startedAt?: string;
  /** ISO-8601 finish timestamp, when known. */
  finishedAt?: string;
}

/** Run feedback for a whole workflow execution. */
export interface GraphWorkflowRunView {
  /** Run identifier. */
  runId: string;
  /** Workflow identifier. */
  workflowId: string;
  /** Terminal/current engine status. */
  status: GraphExecutionStatus | string;
  /** Visual run state of the workflow. */
  visualState: GraphVisualState;
  /** Workflow output values. */
  outputs: Record<string, unknown>;
  /** Per-node run records, keyed by node id. */
  nodes: Record<string, GraphNodeRunView>;
  /** ISO-8601 start timestamp, when known. */
  startedAt?: string;
  /** ISO-8601 finish timestamp, when known. */
  finishedAt?: string;
}

/** View model for a whole workflow document (nodes + edges + optional run). */
export interface GraphWorkflowView {
  /** Workflow identifier. */
  id: string;
  /** Workflow name. */
  name: string;
  /** Workflow input badges. */
  inputs: GraphWorkflowPortView[];
  /** Workflow output badges. */
  outputs: GraphWorkflowPortView[];
  /** Rendered nodes. */
  nodes: GraphNodeView[];
  /** Rendered edges. */
  edges: GraphEdgeView[];
  /** Optional run feedback. */
  run?: GraphWorkflowRunView;
}

/** A JSON-safe manifest/parameter bag carried by a node view. */
export type GraphNodeViewParameters = Record<string, GraphJsonValue>;

/** A resolved port manifest accepted by the port view builder. */
export type GraphPortManifestLike = GraphPortManifest;
