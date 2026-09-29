/**
 * @module as-graph/tests/storybook/render/dom
 * @summary DOM renderer for the shared graph view models.
 * @description Test-only DOM projection consumed by the storybook stories and
 * the e2e UI tests. It turns the framework-neutral {@link GraphWorkflowView}
 * / {@link GraphNodeView} / {@link GraphWorkflowRunView} produced by the shared
 * export into inspectable elements (`data-graph-node`, `data-port`,
 * `data-graph-edge`, `data-node-io`, `data-graph-run`) so a story or an e2e
 * test can assert wiring, ports and per-node intermediate inputs/outputs. It
 * renders no engine code and touches no network, so it works identically in a
 * browser (storybook) and in jsdom (jest).
 */
import type {
  GraphEdgeView,
  GraphNodeRunView,
  GraphNodeView,
  GraphPortView,
  GraphWorkflowView,
} from "../../../src/shared/ui";

/** Test-only error raised when a graph UI assertion fails. */
export class GraphUiAssertionError extends Error {
  /**
   * @param message - The assertion failure description.
   */
  constructor(message: string) {
    super(message);
    this.name = "GraphUiAssertionError";
  }
}

/** Options controlling the workflow render. */
export interface GraphRenderOptions {
  /** Marks a node as selected on the canvas. */
  selectedNodeId?: string;
  /** Renders the per-node I/O panes. Defaults to true when a run exists. */
  showRunIo?: boolean;
}

/** The DOM attributes a rendered node exposes for assertions. */
const NODE_ATTRS = [
  "data-graph-node",
  "data-kind",
  "data-label",
  "data-category",
  "data-color",
  "data-icon",
  "data-state",
  "data-pinned",
  "data-disabled",
  "data-width",
  "data-height",
] as const;

function setIfDefined(
  element: HTMLElement,
  name: string,
  value: string | number | boolean | undefined
): void {
  if (value === undefined) return;
  element.setAttribute(name, String(value));
}

/** Renders a single port element. */
function renderPort(
  port: GraphPortView | Pick<GraphPortView, "id" | "label" | "required">,
  ownerId: string,
  direction?: "input" | "output" | "connection"
): HTMLElement {
  const resolvedDirection =
    direction ?? (port as GraphPortView).direction;
  const hidden =
    (port as GraphPortView).hidden === true;
  const category = (port as GraphPortView).category;
  const handle = (port as GraphPortView).handle;
  const schema = (port as GraphPortView).schema;
  const element = document.createElement("span");
  element.className = "graph-port";
  element.setAttribute(
    "data-port",
    `${ownerId}:${resolvedDirection}:${port.id}`
  );
  element.setAttribute("data-port-id", port.id);
  element.setAttribute("data-port-direction", resolvedDirection);
  element.setAttribute("data-port-label", port.label);
  element.setAttribute("data-port-required", String(port.required));
  element.setAttribute("data-port-hidden", String(hidden));
  setIfDefined(element, "data-port-category", category);
  setIfDefined(element, "data-port-handle", handle);
  setIfDefined(
    element,
    "data-port-schema",
    schema ? JSON.stringify(schema) : undefined
  );
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    const selected = element.getAttribute("data-port-selected") === "true";
    element.setAttribute("data-port-selected", String(!selected));
  });
  element.textContent = port.label;
  return element;
}

/** Renders a node's ports for one direction. */
function renderNodePorts(
  node: GraphNodeView,
  direction: "input" | "output" | "connection",
  ports: GraphPortView[]
): HTMLElement {
  const element = document.createElement("div");
  element.className = `graph-node-ports graph-node-${direction}s`;
  element.setAttribute(`data-node-${direction}-ports`, node.id);
  for (const port of ports) {
    element.appendChild(renderPort(port, node.id));
  }
  return element;
}

/** Renders a node's per-node run I/O pane. */
function renderNodeIo(node: GraphNodeView, run: GraphNodeRunView): HTMLElement {
  const element = document.createElement("div");
  element.className = "graph-node-io";
  element.setAttribute("data-node-io", node.id);
  element.setAttribute("data-node-io-state", run.visualState);
  setIfDefined(element, "data-node-io-status", run.status);
  setIfDefined(element, "data-node-io-from-cache", String(run.fromCache));
  setIfDefined(element, "data-node-io-pinned", String(run.pinned));

  const inputs = document.createElement("pre");
  inputs.setAttribute("data-node-inputs", node.id);
  inputs.textContent = JSON.stringify(run.inputs);
  element.appendChild(inputs);

  const outputs = document.createElement("pre");
  outputs.setAttribute("data-node-outputs", node.id);
  outputs.textContent = JSON.stringify(run.outputs);
  element.appendChild(outputs);

  if (run.error) {
    const error = document.createElement("pre");
    error.setAttribute("data-node-error", node.id);
    error.textContent = JSON.stringify(run.error);
    element.appendChild(error);
  }
  return element;
}

/**
 * Renders a single node view into its DOM element.
 *
 * @param node - The node view model.
 * @param options - The render options.
 * @returns The node DOM element.
 */
export function renderNode(
  node: GraphNodeView,
  options: GraphRenderOptions = {}
): HTMLElement {
  const element = document.createElement("div");
  element.className = "graph-node";
  for (const attr of NODE_ATTRS) {
    const key = attr.replace("data-", "") as keyof GraphNodeView;
    setIfDefined(element, attr, node[key] as string | number | undefined);
  }
  element.setAttribute("data-graph-node", node.id);
  element.setAttribute("data-state", node.visualState);
  element.setAttribute("data-pinned", String(node.pinned));
  element.setAttribute("data-disabled", String(node.disabled));
  setIfDefined(element, "data-glow", node.visualStyle.glow);
  setIfDefined(element, "data-opacity", node.visualStyle.opacity);
  if (options.selectedNodeId === node.id) {
    element.setAttribute("data-selected", "true");
    element.classList.add("selected");
  }
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    const selected = element.getAttribute("data-selected") === "true";
    element.setAttribute("data-selected", String(!selected));
  });

  const title = document.createElement("span");
  title.className = "graph-node-label";
  title.textContent = node.label;
  element.appendChild(title);

  element.appendChild(renderNodePorts(node, "input", node.inputs));
  element.appendChild(renderNodePorts(node, "output", node.outputs));
  if (node.connections.length) {
    element.appendChild(renderNodePorts(node, "connection", node.connections));
  }
  return element;
}

/**
 * Alias for {@link renderNode} kept for readable story call sites.
 */
export const renderGraphNode = renderNode;

/** Renders an edge element. */
export function renderEdge(edge: GraphEdgeView): HTMLElement {
  const element = document.createElement("div");
  element.className = "graph-edge";
  element.setAttribute("data-graph-edge", edge.id);
  element.setAttribute("data-edge-type", edge.type);
  element.setAttribute("data-edge-source", endpointKey(edge.source));
  element.setAttribute("data-edge-target", endpointKey(edge.target));
  element.setAttribute("data-edge-state", edge.visualState);
  if (edge.label) element.setAttribute("data-edge-label", edge.label);
  return element;
}

function endpointKey(endpoint: GraphEdgeView["source"]): string {
  return endpoint.scope === "node"
    ? `node:${endpoint.nodeId}:${endpoint.port}`
    : `workflow:${endpoint.port}`;
}

/**
 * Renders a whole workflow view into a DOM element.
 *
 * @param view - The workflow view model.
 * @param options - The render options.
 * @returns The workflow DOM element.
 */
export function renderGraphWorkflow(
  view: GraphWorkflowView,
  options: GraphRenderOptions = {}
): HTMLElement {
  const root = document.createElement("div");
  root.className = "graph-workflow";
  root.setAttribute("data-graph-workflow", view.id);
  root.setAttribute("data-workflow-name", view.name);

  const inputs = document.createElement("div");
  inputs.setAttribute("data-workflow-inputs", view.id);
  for (const port of view.inputs) {
    inputs.appendChild(renderPort(port, "workflow", "input"));
  }
  root.appendChild(inputs);

  const outputs = document.createElement("div");
  outputs.setAttribute("data-workflow-outputs", view.id);
  for (const port of view.outputs) {
    outputs.appendChild(renderPort(port, "workflow", "output"));
  }
  root.appendChild(outputs);

  const canvas = document.createElement("div");
  canvas.className = "graph-canvas";
  canvas.setAttribute("data-graph-canvas", view.id);
  for (const edge of view.edges) {
    canvas.appendChild(renderEdge(edge));
  }
  const showRunIo = options.showRunIo !== false && Boolean(view.run);
  for (const node of view.nodes) {
    const nodeElement = renderNode(node, options);
    canvas.appendChild(nodeElement);
    const run = view.run?.nodes[node.id];
    if (showRunIo && run) {
      nodeElement.appendChild(renderNodeIo(node, run));
    }
  }
  root.appendChild(canvas);

  if (view.run) {
    root.appendChild(renderRunSummary(view.run));
  }
  return root;
}

/** Renders the workflow run summary. */
function renderRunSummary(
  run: NonNullable<GraphWorkflowView["run"]>
): HTMLElement {
  const element = document.createElement("div");
  element.className = "graph-run";
  element.setAttribute("data-graph-run", run.runId);
  element.setAttribute("data-run-workflow", run.workflowId);
  element.setAttribute("data-run-status", run.status);
  element.setAttribute("data-run-state", run.visualState);
  const outputs = document.createElement("pre");
  outputs.setAttribute("data-run-outputs", run.runId);
  outputs.textContent = JSON.stringify(run.outputs);
  element.appendChild(outputs);
  return element;
}

/** Queries a node element inside a canvas. */
export function graphNodeElement(
  canvas: HTMLElement,
  nodeId: string
): HTMLElement | null {
  return canvas.querySelector<HTMLElement>(
    `[data-graph-node="${nodeId}"]`
  );
}

/** Queries a port element inside a canvas. */
export function graphPortElement(
  canvas: HTMLElement,
  nodeId: string,
  direction: "input" | "output" | "connection",
  portId: string
): HTMLElement | null {
  return canvas.querySelector<HTMLElement>(
    `[data-port="${nodeId}:${direction}:${portId}"]`
  );
}

/** Queries an edge element inside a canvas. */
export function graphEdgeElement(
  canvas: HTMLElement,
  edgeId: string
): HTMLElement | null {
  return canvas.querySelector<HTMLElement>(`[data-graph-edge="${edgeId}"]`);
}

/** Queries the per-node I/O pane inside a canvas. */
export function graphNodeIoElement(
  canvas: HTMLElement,
  nodeId: string
): HTMLElement | null {
  return canvas.querySelector<HTMLElement>(`[data-node-io="${nodeId}"]`);
}

/**
 * Simulates a user click on a node, toggling its selected state.
 *
 * @param canvas - The workflow canvas element.
 * @param nodeId - The node identifier.
 */
export function clickGraphNode(canvas: HTMLElement, nodeId: string): void {
  graphNodeElement(canvas, nodeId)?.dispatchEvent(
    new MouseEvent("click", { bubbles: true })
  );
}

/**
 * Simulates a user click on a port, toggling its selected state.
 *
 * @param canvas - The workflow canvas element.
 * @param nodeId - The owning node identifier.
 * @param direction - The port direction.
 * @param portId - The port identifier.
 */
export function clickGraphPort(
  canvas: HTMLElement,
  nodeId: string,
  direction: "input" | "output" | "connection",
  portId: string
): void {
  graphPortElement(canvas, nodeId, direction, portId)?.dispatchEvent(
    new MouseEvent("click", { bubbles: true })
  );
}

/** Reads the intermediate inputs displayed for a node. */
export function nodeRunInputs(
  canvas: HTMLElement,
  nodeId: string
): Record<string, unknown> {
  const element = canvas.querySelector<HTMLElement>(
    `[data-node-inputs="${nodeId}"]`
  );
  return element ? (JSON.parse(element.textContent ?? "{}") as Record<string, unknown>) : {};
}

/** Reads the intermediate outputs displayed for a node. */
export function nodeRunOutputs(
  canvas: HTMLElement,
  nodeId: string
): Record<string, unknown> {
  const element = canvas.querySelector<HTMLElement>(
    `[data-node-outputs="${nodeId}"]`
  );
  return element ? (JSON.parse(element.textContent ?? "{}") as Record<string, unknown>) : {};
}

/**
 * Asserts a condition, throwing a {@link GraphUiAssertionError} otherwise.
 *
 * @param condition - The condition to assert.
 * @param message - The failure message.
 */
export function assertGraph(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new GraphUiAssertionError(message);
}
