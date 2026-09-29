import { ValidationError } from "@decaf-ts/db-decorators";
import type { GraphJsonValue } from "./GraphJsonValue";
import {
  isGraphJsonSafeValue,
  isGraphUnsafeObjectKey,
} from "./GraphJsonValue";
import type { GraphEndpoint, GraphNodeEndpoint, GraphWorkflowEndpoint } from "./GraphEndpoint";
import { isGraphEndpoint, isGraphNodeEndpoint, isGraphWorkflowEndpoint } from "./GraphEndpoint";
import { isGraphInputBinding } from "./GraphNodeBinding";
import type { GraphValueReference } from "./GraphLoopConfiguration";
import type { GraphLoopConfiguration } from "./GraphLoopConfiguration";
import type { GraphWorkflowUiState } from "./GraphWorkflowUiState";
import type { GraphEdgeInstance } from "./GraphEdgeInstance";
import type { GraphNodeInstance } from "./GraphNodeInstance";
import type {
  GraphWorkflowDocument,
  GraphWorkflowPortInstance,
  GraphWorkflowSettings,
} from "./GraphWorkflowDocument";
import { isGraphValueSchema } from "../catalog/GraphValueSchema";

/** A workflow boundary port accepted by {@link GraphWorkflowDocumentBuilder}. */
export type GraphWorkflowPortInput = GraphWorkflowPortInstance;

/** Options for constructing a {@link GraphWorkflowDocumentBuilder}. */
export interface GraphWorkflowDocumentBuilderOptions {
  /** Document id; defaults to an empty string when omitted. */
  id?: string;
  /** Human-readable document name; defaults to an empty string when omitted. */
  name?: string;
}

/**
 * Fluent builder for the canonical {@link GraphWorkflowDocument}
 * (DECAF-50 §4.4.4). Collects boundary ports, node instances, edges, and
 * optional settings/metadata/UI state, then validates and freezes a
 * defensively-copied document on {@link GraphWorkflowDocumentBuilder.build}.
 */
export class GraphWorkflowDocumentBuilder {
  private readonly document: GraphWorkflowDocument;

  /**
   * @param id Document id.
   * @param name Optional document name; defaults to an empty string.
   */
  constructor(id: string, name?: string) {
    this.document = {
      id,
      name: name ?? "",
      inputs: [],
      outputs: [],
      nodes: [],
      edges: [],
    };
  }

  /** Appends a workflow input port. */
  addInput(port: GraphWorkflowPortInput): this {
    this.document.inputs.push(port);
    return this;
  }

  /** Appends a workflow output port. */
  addOutput(port: GraphWorkflowPortInput): this {
    this.document.outputs.push(port);
    return this;
  }

  /** Appends a node instance, defaulting `parameters` to an empty object. */
  addNode(node: GraphNodeInstance): this {
    this.document.nodes.push({
      ...node,
      parameters: node.parameters ?? {},
    });
    return this;
  }

  /** Appends an edge instance. */
  addEdge(edge: GraphEdgeInstance): this {
    this.document.edges.push(edge);
    return this;
  }

  /** Sets (or clears) the document's free-form settings bag. */
  setSettings(settings?: GraphWorkflowSettings): this {
    this.document.settings = settings;
    return this;
  }

  /** Sets (or clears) the document's metadata bag. */
  setMetadata(metadata?: Record<string, GraphJsonValue>): this {
    this.document.metadata = metadata;
    return this;
  }

  /** Sets (or clears) the document's editor UI state. */
  setUi(ui?: GraphWorkflowUiState): this {
    this.document.ui = ui;
    return this;
  }

  /**
   * Validates the accumulated document with
   * {@link assertGraphWorkflowDocumentValid} and returns a deep-ish copy:
   * ports, nodes, and edges are cloned per entry, and the optional
   * `settings`/`metadata`/`ui` bags are only present when explicitly set, so
   * callers never observe builder-internal `undefined` fields.
   *
   * @throws ValidationError when the document fails validation.
   */
  build(): GraphWorkflowDocument {
    assertGraphWorkflowDocumentValid(this.document);
    const document: GraphWorkflowDocument = {
      id: this.document.id,
      name: this.document.name,
      inputs: this.document.inputs.map((port) => ({ ...port })),
      outputs: this.document.outputs.map((port) => ({ ...port })),
      nodes: this.document.nodes.map((node) => ({ ...node })),
      edges: this.document.edges.map((edge) => ({ ...edge })),
    };
    if (this.document.settings !== undefined) {
      document.settings = this.document.settings;
    }
    if (this.document.metadata !== undefined) {
      document.metadata = this.document.metadata;
    }
    if (this.document.ui !== undefined) {
      document.ui = this.document.ui;
    }
    return document;
  }
}

/**
 * Shared validation context for
 * {@link assertGraphWorkflowDocumentValid}: tracks documents already visited
 * on the current nesting path so cyclic loop bodies are detected.
 */
export interface GraphWorkflowDocumentValidationContext {
  seen: unknown[];
}

/**
 * Structural validation gate for a canonical {@link GraphWorkflowDocument}
 * (shared by the frontend builder and the backend nine-stage validator,
 * DECAF-50 §4.8 stage 1 shape rules). Checks unique port/node/edge ids,
 * valid schemas, binding shapes, edge endpoints, and recursively validates
 * nested loop-body documents.
 *
 * @throws ValidationError describing the first invalid aspect found.
 */
export function assertGraphWorkflowDocumentValid(
  document: GraphWorkflowDocument,
  context: GraphWorkflowDocumentValidationContext = { seen: [] }
): void {
  if (context.seen.includes(document)) {
    throw new ValidationError(
      `Document '${describeDocument(document)}' contains a loop body that references itself (cyclic document)`
    );
  }
  if (typeof document.id !== "string" || !document.id) {
    throw new ValidationError("Document 'id' is required and must be a non-empty string");
  }
  if (typeof document.name !== "string" || !document.name) {
    throw new ValidationError("Document 'name' is required and must be a non-empty string");
  }
  const workflowPorts = new Set<string>();
  for (const port of [...document.inputs, ...document.outputs]) {
    if (typeof port.id !== "string" || !port.id) {
      throw new ValidationError(
        "Workflow port 'id' is required and must be a non-empty string"
      );
    }
    if (workflowPorts.has(port.id)) {
      throw new ValidationError(
        `Workflow port '${port.id}' is declared more than once; workflow port ids must be unique`
      );
    }
    if (port.schema !== undefined && !isGraphValueSchema(port.schema)) {
      throw new ValidationError(
        `Workflow port '${port.id}' schema must be a valid GraphValueSchema`
      );
    }
    workflowPorts.add(port.id);
  }
  const nestedContext: GraphWorkflowDocumentValidationContext = {
    seen: [...context.seen, document],
  };
  const nodeIds = new Set<string>();
  for (const node of document.nodes) {
    assertGraphNodeValid(node, nodeIds);
  }
  for (const node of document.nodes) {
    if (node.loop) {
      assertGraphLoopConfigurationValid(node, node.loop, nestedContext);
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    assertGraphEdgeValid(edge, edgeIds);
  }
  for (const edge of document.edges) {
    assertEdgeEndpoint(
      edge.source,
      document,
      workflowPorts,
      nodeIds,
      `Edge '${edge.id}' source`
    );
    assertEdgeEndpoint(
      edge.target,
      document,
      workflowPorts,
      nodeIds,
      `Edge '${edge.id}' target`
    );
  }
  if (document.settings !== undefined && !isGraphJsonSafeValue(document.settings)) {
    throw new ValidationError(
      "Document settings must be JSON-safe (a map of JSON-safe values)"
    );
  }
  if (document.metadata !== undefined && !isGraphJsonSafeValue(document.metadata)) {
    throw new ValidationError(
      "Document metadata must be JSON-safe: functions, class instances, undefined, NaN/Infinity, symbol keys, or unsafe prototype keys are not allowed"
    );
  }
  if (document.ui !== undefined && !isGraphJsonSafeValue(document.ui)) {
    throw new ValidationError(
      "Document ui must be JSON-safe: functions, class instances, undefined, NaN/Infinity, symbol keys, or unsafe prototype keys are not allowed"
    );
  }
}

function describeDocument(document: unknown): string {
  const id = (document as Record<string, unknown>)?.["id"];
  return typeof id === "string" ? id : "<unnamed document>";
}

function assertGraphNodeValid(node: GraphNodeInstance, nodeIds: Set<string>): void {
  if (typeof node.id !== "string" || !node.id) {
    throw new ValidationError("Node 'id' is required and must be a non-empty string");
  }
  if (nodeIds.has(node.id)) {
    throw new ValidationError(
      `Node id '${node.id}' is declared more than once; node ids must be unique`
    );
  }
  if (typeof node.kind !== "string" || !node.kind) {
    throw new ValidationError(
      `Node '${node.id}' must declare a non-empty string 'kind'`
    );
  }
  if (node.parameters === undefined || node.parameters === null) {
    throw new ValidationError(
      `Node '${node.id}' parameters must be present (an empty object when there are none)`
    );
  }
  nodeIds.add(node.id);
  if (node.inputBindings) {
    for (const [key, binding] of Object.entries(node.inputBindings)) {
      if (isGraphUnsafeObjectKey(key)) {
        throw new ValidationError(
          `Node '${node.id}' input binding key '${key}' is not allowed (unsafe prototype-pollutant key)`
        );
      }
      if (!isGraphInputBinding(binding)) {
        throw new ValidationError(
          `Node '${node.id}' input binding for '${key}' must be a valid GraphInputBinding (edge, literal, or expression)`
        );
      }
      if (binding.mode === "literal" && !isGraphJsonSafeValue(binding.value)) {
        throw new ValidationError(
          `Node '${node.id}' literal binding for '${key}' must contain JSON-safe values`
        );
      }
      if (binding.mode === "expression" && !binding.expression) {
        throw new ValidationError(
          `Node '${node.id}' expression binding for '${key}' must contain a non-empty expression`
        );
      }
    }
  }
  if (node.outputBindings) {
    for (const [key, binding] of Object.entries(node.outputBindings)) {
      if (isGraphUnsafeObjectKey(key)) {
        throw new ValidationError(
          `Node '${node.id}' output binding key '${key}' is not allowed (unsafe prototype-pollutant key)`
        );
      }
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        throw new ValidationError(
          `Node '${node.id}' output binding for '${key}' must be an object with enabled and alias settings`
        );
      }
    }
  }
  if (!isGraphJsonSafeValue(node.parameters)) {
    throw new ValidationError(
      `Node '${node.id}' parameters must be JSON-safe: functions, class instances, undefined, NaN/Infinity, symbol keys, or unsafe prototype keys are not allowed`
    );
  }
}

function assertGraphLoopConfigurationValid(
  node: GraphNodeInstance,
  config: GraphLoopConfiguration,
  context: GraphWorkflowDocumentValidationContext
): void {
  if (!config.body || typeof config.body !== "object") {
    throw new ValidationError(
      `Node '${node.id}' loop configuration requires a body document`
    );
  }
  assertGraphWorkflowDocumentValid(config.body, context);
  if (
    config.maxIterations !== undefined &&
    (!Number.isFinite(config.maxIterations) || config.maxIterations <= 0)
  ) {
    throw new ValidationError(
      `Node '${node.id}' loop maxIterations must be a positive number`
    );
  }
  if (
    config.timeoutMs !== undefined &&
    (typeof config.timeoutMs !== "number" || config.timeoutMs <= 0)
  ) {
    throw new ValidationError(
      `Node '${node.id}' loop timeoutMs must be a positive number in milliseconds`
    );
  }
  if (
    config.concurrency !== undefined &&
    (typeof config.concurrency !== "number" || config.concurrency <= 0)
  ) {
    throw new ValidationError(
      `Node '${node.id}' loop concurrency must be a positive number`
    );
  }
  for (const mappings of [config.inputMappings, config.outputMappings]) {
    if (!mappings) continue;
    for (const [key, reference] of Object.entries(mappings)) {
      if (isGraphUnsafeObjectKey(key)) {
        throw new ValidationError(
          `Node '${node.id}' loop mapping key '${key}' is not allowed (unsafe prototype-pollutant key)`
        );
      }
      assertGraphValueReferenceShape(reference, node.id, key);
    }
  }
}

function assertGraphValueReferenceShape(
  reference: GraphValueReference,
  nodeId: string,
  mappingKey: string
): void {
  if (!reference || typeof reference !== "object") {
    throw new ValidationError(
      `Node '${nodeId}' loop mapping '${mappingKey}' must reference a workflow port, node port, literal, or expression`
    );
  }
  switch (reference.source) {
    case "workflow":
      if (typeof reference.port !== "string" || !reference.port) {
        throw new ValidationError(
          `Node '${nodeId}' loop mapping '${mappingKey}' referencing a workflow must reference a port identifier`
        );
      }
      break;
    case "node":
      if (
        typeof reference.nodeId !== "string" ||
        !reference.nodeId ||
        typeof reference.port !== "string" ||
        !reference.port
      ) {
        throw new ValidationError(
          `Node '${nodeId}' loop mapping '${mappingKey}' referencing a node must reference a node id and a port`
        );
      }
      break;
    case "literal":
      if (!isGraphJsonSafeValue(reference.value)) {
        throw new ValidationError(
          `Node '${nodeId}' loop mapping '${mappingKey}' literal references must be JSON-safe values`
        );
      }
      break;
    case "expression":
      if (typeof reference.expression !== "string" || !reference.expression) {
        throw new ValidationError(
          `Node '${nodeId}' loop mapping '${mappingKey}' expression references must be non-empty expressions`
        );
      }
      break;
    default:
      throw new ValidationError(
        `Node '${nodeId}' loop mapping '${mappingKey}' must use a workflow, node, literal, or expression reference source`
      );
  }
}

function assertGraphEdgeValid(edge: GraphEdgeInstance, edgeIds: Set<string>): void {
  if (typeof edge.id !== "string" || !edge.id) {
    throw new ValidationError("Edge 'id' is required and must be a non-empty string");
  }
  if (edgeIds.has(edge.id)) {
    throw new ValidationError(
      `Edge id '${edge.id}' is declared more than once; edge ids must be unique`
    );
  }
  if (!isGraphEndpoint(edge.source)) {
    throw new ValidationError(
      `Edge '${edge.id}' source endpoint is not a valid GraphEndpoint`
    );
  }
  if (!isGraphEndpoint(edge.target)) {
    throw new ValidationError(
      `Edge '${edge.id}' target endpoint is not a valid GraphEndpoint`
    );
  }
  if (edge.type !== "data" && edge.type !== "connection") {
    throw new ValidationError(
      `Edge '${edge.id}' type '${String(edge.type)}' is not a valid edge type (data or connection are allowed)`
    );
  }
  edgeIds.add(edge.id);
  if (!isGraphJsonSafeValue(edge)) {
    throw new ValidationError(
      `Edge '${edge.id}' contains values that are not JSON-safe: functions, class instances, undefined, NaN/Infinity, symbol keys, or unsafe prototype keys are not allowed`
    );
  }
}

function assertEdgeEndpoint(
  endpoint: GraphEndpoint,
  document: GraphWorkflowDocument,
  workflowPorts: Set<string>,
  nodeIds: Set<string>,
  context: string
): void {
  if (isGraphWorkflowEndpoint(endpoint)) {
    if (!workflowPorts.has(endpoint.port)) {
      throw new ValidationError(
        `${context} references workflow port '${endpoint.port}' which is not declared on the document`
      );
    }
    return;
  }
  if (isGraphNodeEndpoint(endpoint)) {
    if (!nodeIds.has(endpoint.nodeId)) {
      throw new ValidationError(
        `${context} references node '${endpoint.nodeId}' which is not part of the document`
      );
    }
    if (typeof endpoint.port !== "string" || !endpoint.port) {
      throw new ValidationError(
        `${context} node endpoints must reference a non-empty port identifier`
      );
    }
  }
}

export type { GraphWorkflowEndpoint, GraphNodeEndpoint };
