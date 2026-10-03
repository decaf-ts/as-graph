import { ValidationError } from "@decaf-ts/db-decorators";
import type { Constructor } from "@decaf-ts/decoration";
import type { Model } from "@decaf-ts/decorator-validation";
import type {
  GraphPortDefinition,
  GraphWorkflowDefinition,
  GraphWorkflowNodeMetadata,
  GraphWorkflowRelationMetadata,
} from "../constants";
import {
  graphLeafPortsOf,
  graphWorkflowDefinitionOf,
} from "../reader";
import {
  graphDeclaredInputKeysOf,
  graphNodeClassMetadataOf,
  graphNodeParameterDefaultsOf,
  graphNodeStateDefaultsOf,
  graphNodeStateValuesOf,
  graphPortDefaultValueOf,
  uniqueGraphNodeId,
} from "./GraphNodeDerivation";
import {
  GRAPH_AUTH_METADATA_KEY,
  graphAuthMetadataOf,
  graphAuthMetadataWith,
} from "../auth";
import type { GraphWorkflowDocument, GraphWorkflowPortInstance } from "./GraphWorkflowDocument";
import type { GraphNodeInstance } from "./GraphNodeInstance";
import type { GraphEdgeInstance } from "./GraphEdgeInstance";
import type { GraphEndpoint, GraphNodeEndpoint, GraphWorkflowEndpoint } from "./GraphEndpoint";
import type { GraphJsonValue } from "./GraphJsonValue";
import { isGraphJsonSafeValue } from "./GraphJsonValue";
import type {
  GraphNodeUiState,
  GraphWorkflowUiState,
  GraphWorkflowViewport,
} from "./GraphWorkflowUiState";
import type { GraphLoopConfiguration } from "./GraphLoopConfiguration";
import type { GraphValueSchema } from "../catalog/GraphValueSchema";
import {
  graphValueSchemaFromValidation,
  type GraphValidationRecord,
} from "../catalog/GraphValueSchemaDerivation";
import { GraphWorkflowDocumentBuilder } from "./GraphWorkflowDocumentBuilder";

/**
 * Options for compiling a decorated workflow into a canonical
 * {@link GraphWorkflowDocument}.
 */
export interface GraphDecoratedWorkflowCompileOptions {
  /** Document id; defaults to the workflow's tag or name. */
  id?: string;
  /** Human-readable document name; defaults to the workflow's name. */
  name?: string;
  /** Canvas positions per node id, carried into the document's UI state. */
  positions?: Record<string, { x: number; y: number }>;
  /** Initial canvas viewport carried into the document's UI state. */
  viewport?: GraphWorkflowViewport;
}

/** Anything the compiler can resolve into a {@link GraphWorkflowDefinition}: a decorated workflow class (constructor), a model instance, or a definition. */
export type GraphDecoratedWorkflowInput = Constructor | Model | GraphWorkflowDefinition;

const GRAPH_BOUNDARY_ALIASES = ["$workflow", "workflow", "graph"];

const GRAPH_DATE_TYPE_NAME_FORMATS: Record<string, string> = {
  date: "date",
  datetime: "date-time",
  "date-time": "date-time",
  duration: "duration",
};


type GraphNodeDefinitionShim = {
  name: string;
  tag?: string;
  kind?: string;
  ports: GraphPortDefinition[];
  graph?: { metadata?: Record<string, unknown> } & Record<string, unknown>;
};

/**
 * Compiles a decorated workflow (or an already-resolved
 * {@link GraphWorkflowDefinition}) into a canonical
 * {@link GraphWorkflowDocument}: workflow boundary ports, one instance per
 * node (input-port defaults and loop/switch metadata folded into
 * `parameters`/`metadata`), one edge per relation, plus UI state. Browser-safe:
 * node constructors are never invoked, so `@node` classes can seed demo
 * graphs without engine imports (DECAF-50 §4.4.4).
 *
 * @throws ValidationError when the input cannot be resolved to a decorated
 * graph workflow definition.
 */
export function graphDecoratedWorkflowCompiler(
  workflow: GraphDecoratedWorkflowInput,
  options: GraphDecoratedWorkflowCompileOptions = {}
): GraphWorkflowDocument {
  const definition = resolveGraphWorkflowDefinition(workflow);
  const usedNodeIds = new Set<string>();
  const resolvedIds = new Map<GraphWorkflowNodeMetadata, string>();
  const nodes = definition.nodes.map((nodeMetadata, index) =>
    graphNodeInstanceOf(
      nodeMetadata,
      definition,
      options.positions ?? {},
      index,
      usedNodeIds,
      resolvedIds
    )
  );
  const builder = new GraphWorkflowDocumentBuilder(
    options.id ?? definition.tag ?? definition.name,
    options.name ?? definition.name
  );
  for (const port of graphLeafPortsOf(definition.inputs)) {
    builder.addInput(graphWorkflowPortOf(port));
  }
  for (const port of graphLeafPortsOf(definition.outputs)) {
    builder.addOutput(graphWorkflowPortOf(port));
  }
  for (const node of nodes) {
    builder.addNode(node);
  }
  definition.relations.forEach((relation, index) => {
    builder.addEdge(
      graphEdgeOf(relation, definition, index, workflow, resolvedIds)
    );
  });
  builder.setUi(graphWorkflowUiStateOf(options));
  builder.setMetadata(graphDocumentMetadataOf(definition));
  return builder.build();
}

function resolveGraphWorkflowDefinition(
  workflow: GraphDecoratedWorkflowInput
): GraphWorkflowDefinition {
  try {
    return graphWorkflowDefinitionOf(workflow);
  } catch (e) {
    throw new ValidationError(
      `Could not resolve a decorated graph workflow from the given value: ${String(e)}`
    );
  }
}

function graphWorkflowPortOf(port: GraphPortDefinition): GraphWorkflowPortInstance {
  const workflowPort: GraphWorkflowPortInstance = {
    id: port.path ?? port.property,
    label: port.label,
    schema: graphPortSchemaOf(port),
    required: port.required,
  };
  const defaultValue = graphPortDefaultValueOf(port);
  if (defaultValue !== undefined) workflowPort.defaultValue = defaultValue;
  const category = port.graph?.["category"];
  if (typeof category === "string") workflowPort.metadata = { category };
  return workflowPort;
}

function graphPortSchemaOf(port: GraphPortDefinition): GraphValueSchema {
  if (port.type && port.type in GRAPH_DATE_TYPE_NAME_FORMATS) {
    return { type: "string", format: GRAPH_DATE_TYPE_NAME_FORMATS[port.type] };
  }
  return graphValueSchemaFromValidation(
    port.validation as GraphValidationRecord | undefined,
    port.type,
    port.model
  );
}

function graphWorkflowUiStateOf(
  options: GraphDecoratedWorkflowCompileOptions
): GraphWorkflowUiState | undefined {
  if (!options.viewport) return undefined;
  return { viewport: { ...options.viewport } };
}

function graphNodeInstanceOf(
  nodeMetadata: GraphWorkflowNodeMetadata,
  workflow: GraphWorkflowDefinition,
  positions: Record<string, { x: number; y: number }>,
  index: number,
  usedIds: Set<string>,
  resolvedIds: Map<GraphWorkflowNodeMetadata, string>
): GraphNodeInstance {
  const nodeDefinition = isGraphModelLike(nodeMetadata.node)
    ? graphNodeDefinitionSafely(nodeMetadata.node)
    : undefined;
  const id = uniqueGraphNodeId(
    nodeMetadata.id ?? nodeDefinition?.tag ?? nodeDefinition?.kind ?? `n${index}`,
    usedIds
  );
  resolvedIds.set(nodeMetadata, id);
  const kind =
    nodeMetadata.kind ??
    nodeDefinition?.kind ??
    nodeDefinition?.name ??
    nodeMetadata.id ??
    id;
  const instance: GraphNodeInstance = {
    id,
    kind,
    parameters: graphNodeParametersOf(nodeMetadata, nodeDefinition),
  };
  if (nodeMetadata.label !== undefined) instance.label = nodeMetadata.label;
  const metadata = graphNodeMetadataCollectionOf(nodeMetadata, nodeDefinition);
  if (metadata) instance.metadata = metadata;
  const state = graphNodeStateOf(nodeMetadata);
  if (state) instance.state = state;
  const loop = graphLoopConfigurationOf(nodeMetadata, nodeDefinition, id);
  if (loop) instance.loop = loop;
  const position = positions[id] ?? positions[nodeMetadata.id ?? ""];
  if (position) {
    const ui: GraphNodeUiState = { position: { x: position.x, y: position.y } };
    instance.ui = ui;
  }
  return instance;
}

function graphNodeStateOf(
  nodeMetadata: GraphWorkflowNodeMetadata
): Record<string, GraphJsonValue> | undefined {
  if (!nodeMetadata.node || !isGraphModelLike(nodeMetadata.node)) return undefined;
  const state =
    typeof nodeMetadata.node === "function"
      ? graphNodeStateDefaultsOf(nodeMetadata.node as Constructor)
      : graphNodeStateValuesOf(nodeMetadata.node as Model);
  return Object.keys(state).length ? state : undefined;
}

function graphNodeMetadataCollectionOf(
  nodeMetadata: GraphWorkflowNodeMetadata,
  nodeDefinition: GraphNodeDefinitionShim | undefined
): Record<string, GraphJsonValue> | undefined {
  const collected: Record<string, GraphJsonValue> = {
    ...(graphNodeClassMetadataOf(
      (nodeDefinition ?? {}) as unknown as Parameters<
        typeof graphNodeClassMetadataOf
      >[0]
    ) ?? {}),
  };
  const source = nodeMetadata.metadata as Record<string, unknown> | undefined;
  if (source && typeof source === "object") {
    const declaredInputs = nodeDefinition
      ? graphDeclaredInputKeysOf(nodeDefinition.ports)
      : new Set<string>();
    for (const [key, value] of Object.entries(source)) {
      if (key === "loop") continue;
      // A node-config entry naming a declared input port is configuration and
      // is folded into `parameters` by `graphNodeParametersOf`, not metadata.
      if (declaredInputs.has(key)) continue;
      reflectJsonSafeValue(collected, key, value);
    }
  }
  return Object.keys(collected).length ? collected : undefined;
}

function reflectJsonSafeValue(
  collected: Record<string, GraphJsonValue>,
  key: string,
  value: unknown
): void {
  if (value === undefined || typeof value === "function") return;
  if (!isGraphJsonSafeValue(value)) return;
  try {
    collected[key] = JSON.parse(JSON.stringify(value)) as GraphJsonValue;
  } catch {
    return;
  }
}

/**
 * Loop-configuration fields of legacy `graph.metadata.loop` bags that are
 * node configuration rather than loop-body settings. Per DECAF-50 §4.4.5
 * rule 6 (non-port operation/configuration fields belong in `parameters`),
 * these are carried into the instance's `parameters` so legacy loop
 * round-trips stay lossless; `body`/`maxIterations`/`timeoutMs`/
 * `concurrency` live on {@link GraphLoopConfiguration}.
 */
const GRAPH_LOOP_PARAMETER_KEYS = [
  "condition",
  "inputPort",
  "outputPort",
  "itemPort",
  "resultPort",
  "statePort",
  "slice",
] as const;

function graphNodeParametersOf(
  nodeMetadata: GraphWorkflowNodeMetadata,
  nodeDefinition: GraphNodeDefinitionShim | undefined
): Record<string, GraphJsonValue> {
  const parameters: Record<string, GraphJsonValue> = nodeDefinition
    ? graphNodeParameterDefaultsOf(nodeDefinition.ports)
    : {};
  // Node-configuration `metadata` entries that name a declared input port are
  // port configuration (e.g. a `code` override for `core.utility.code`), so fold
  // them into `parameters` to match the canonical document and the manifest's
  // required-parameter validation.
  if (nodeDefinition) {
    const declaredInputs = graphDeclaredInputKeysOf(nodeDefinition.ports);
    const source = nodeMetadata.metadata as Record<string, unknown> | undefined;
    if (source && typeof source === "object") {
      for (const [key, value] of Object.entries(source)) {
        if (!declaredInputs.has(key)) continue;
        if (value === undefined || typeof value === "function") continue;
        if (!isGraphJsonSafeValue(value)) continue;
        try {
          parameters[key] = JSON.parse(JSON.stringify(value)) as GraphJsonValue;
        } catch {
          // skip non-serializable configuration values
        }
      }
    }
  }
  const loopMetadata = graphLegacyLoopMetadataOf(nodeMetadata, nodeDefinition);
  if (loopMetadata) {
    for (const key of GRAPH_LOOP_PARAMETER_KEYS) {
      const value = loopMetadata[key];
      if (value === undefined || typeof value === "function") continue;
      if (!isGraphJsonSafeValue(value)) continue;
      try {
        parameters[key] = JSON.parse(JSON.stringify(value)) as GraphJsonValue;
      } catch {
        // skip non-serializable legacy values
      }
    }
  }
  return parameters;
}

/**
 * Reads the legacy `graph.metadata.loop` bag from either the node metadata or
 * the node definition shim, so loop-configuration fields can be split between
 * {@link GraphLoopConfiguration} and instance `parameters` (§4.4.5 rule 6).
 */
function graphLegacyLoopMetadataOf(
  nodeMetadata: GraphWorkflowNodeMetadata,
  nodeDefinition: GraphNodeDefinitionShim | undefined
): Record<string, unknown> | undefined {
  const loopMetadata =
    ((nodeMetadata.metadata as Record<string, unknown> | undefined)?.["loop"] as
      | Record<string, unknown>
      | undefined) ??
    (nodeDefinition?.graph?.metadata as Record<string, unknown> | undefined)?.["loop"];
  return loopMetadata && typeof loopMetadata === "object"
    ? (loopMetadata as Record<string, unknown>)
    : undefined;
}

function graphLoopConfigurationOf(
  nodeMetadata: GraphWorkflowNodeMetadata,
  nodeDefinition: GraphNodeDefinitionShim | undefined,
  nodeId: string
): GraphLoopConfiguration | undefined {
  const loopMetadata =
    ((nodeMetadata.metadata as Record<string, unknown> | undefined)?.["loop"] as
      | Record<string, unknown>
      | undefined) ??
    (nodeDefinition?.graph?.metadata as Record<string, unknown> | undefined)?.["loop"];
  if (!loopMetadata || typeof loopMetadata !== "object") return undefined;
  const config = loopMetadata as Record<string, unknown>;
  const bodySource = config["body"];
  if (!bodySource) return undefined;
  let body: GraphWorkflowDocument;
  try {
    body = graphDecoratedWorkflowCompiler(bodySource as GraphDecoratedWorkflowInput);
  } catch (e) {
    throw new ValidationError(
      `Failed to compile the loop body of node '${nodeId}': ${String(e)}`
    );
  }
  const loop: GraphLoopConfiguration = { body };
  const maxIterations = asNumber(config["maxIterations"]);
  const timeoutMs = asNumber(config["timeoutMs"]);
  const concurrency = asNumber(config["concurrency"]);
  if (maxIterations !== undefined) loop.maxIterations = maxIterations;
  if (timeoutMs !== undefined) loop.timeoutMs = timeoutMs;
  if (concurrency !== undefined) loop.concurrency = concurrency;
  return loop;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function graphDocumentMetadataOf(
  definition: GraphWorkflowDefinition
): Record<string, GraphJsonValue> | undefined {
  const collected: Record<string, GraphJsonValue> = {};
  for (const [key, value] of Object.entries(definition.workflow?.metadata ?? {})) {
    reflectJsonSafeValue(collected, key, value);
  }
  // Fold the workflow class's `@namespace(...)` requirement (or explicit
  // `namespaces` option) into the reserved `auth` document-metadata key so the
  // engine can authorize the whole graph before executing any node.
  const declared = graphAuthMetadataOf(collected);
  const auth = graphAuthMetadataWith({
    namespaces: definition.namespaces ?? declared?.namespaces,
    roles: declared?.roles,
  });
  if (auth) collected[GRAPH_AUTH_METADATA_KEY] = auth as unknown as GraphJsonValue;
  return Object.keys(collected).length ? collected : undefined;
}

function graphEdgeOf(
  relation: GraphWorkflowRelationMetadata,
  workflow: GraphWorkflowDefinition,
  index: number,
  workflowSelf?: unknown,
  resolvedIds?: Map<GraphWorkflowNodeMetadata, string>
): GraphEdgeInstance {
  const aliases = [...GRAPH_BOUNDARY_ALIASES, workflow.name];
  const source = graphEndpointOf(
    relation.source,
    relation.sourcePort,
    workflow.nodes,
    aliases,
    workflowSelf,
    resolvedIds
  );
  const target = graphEndpointOf(
    relation.target,
    relation.targetPort,
    workflow.nodes,
    aliases,
    workflowSelf,
    resolvedIds
  );
  const metadata = graphJsonSafeRecordOf(relation.metadata);
  const edge: GraphEdgeInstance = {
    id: `re${index}`,
    type: graphEdgeTypeOf(relation, workflow, workflowSelf),
    source,
    target,
  };
  if (relation.label !== undefined) edge.label = relation.label;
  if (metadata) edge.metadata = metadata;
  return edge;
}

function graphEdgeTypeOf(
  relation: GraphWorkflowRelationMetadata,
  workflow: GraphWorkflowDefinition,
  workflowSelf?: unknown
): "data" | "connection" {
  const sourceDefinition = graphNodeDefinitionFor(
    relation.source,
    workflow,
    workflowSelf
  );
  const targetDefinition = graphNodeDefinitionFor(
    relation.target,
    workflow,
    workflowSelf
  );
  if (isConnectionPort(sourceDefinition, relation.sourcePort)) return "connection";
  if (isConnectionPort(targetDefinition, relation.targetPort)) return "connection";
  return "data";
}

function isConnectionPort(
  nodeDefinition: GraphNodeDefinitionShim | undefined,
  port: string | undefined
): boolean {
  if (!nodeDefinition || !port) return false;
  return nodeDefinition.ports.some(
    (candidate) =>
      (candidate.path ?? candidate.property) === port && candidate.direction === "connection"
  );
}

function graphNodeDefinitionFor(
  reference: unknown,
  workflow: GraphWorkflowDefinition,
  workflowSelf?: unknown
): GraphNodeDefinitionShim | undefined {
  if (workflowSelf !== undefined && reference === workflowSelf) return undefined;
  const matched = findGraphNodeMatch(
    reference,
    workflow.name ? [...GRAPH_BOUNDARY_ALIASES, workflow.name] : GRAPH_BOUNDARY_ALIASES,
    workflow.nodes
  );
  if (!matched || !isGraphModelLike(matched.node)) return undefined;
  return graphNodeDefinitionSafely(matched.node);
}

function graphJsonSafeRecordOf(
  value:
    | Record<string, unknown>
    | undefined
): Record<string, GraphJsonValue> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const collected: Record<string, GraphJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    reflectJsonSafeValue(collected, key, entry);
  }
  return Object.keys(collected).length ? collected : undefined;
}

function graphEndpointOf(
  value: unknown,
  port: string | undefined,
  nodes: GraphWorkflowNodeMetadata[],
  aliases: string[],
  workflowSelf?: unknown,
  resolvedIds?: Map<GraphWorkflowNodeMetadata, string>
): GraphEndpoint {
  const resolvedPort = port ?? "";
  if (workflowSelf !== undefined && value === workflowSelf) {
    return { scope: "workflow", port: resolvedPort } satisfies GraphWorkflowEndpoint;
  }
  if (typeof value === "string" && aliases.includes(value)) {
    return { scope: "workflow", port: resolvedPort } satisfies GraphWorkflowEndpoint;
  }
  const matched = findGraphNodeMatch(value, aliases, nodes);
  if (matched) {
    const nodeId = resolvedIds?.get(matched) ?? matched.id ?? "";
    const endpoint: GraphNodeEndpoint = {
      scope: "node",
      nodeId,
      port: resolvedPort,
    };
    if (!resolvedPort) {
      throw new ValidationError(
        `Workflow relation references node '${nodeId}' without a port identifier`
      );
    }
    return endpoint;
  }
  throw new ValidationError(
    `Workflow relation references '${String(
      value
    )}' which is neither a node in the workflow nor a workflow boundary (used port identifier: '${resolvedPort}')`
  );
}

function findGraphNodeMatch(
  value: unknown,
  aliases: string[],
  nodes: GraphWorkflowNodeMetadata[]
): GraphWorkflowNodeMetadata | undefined {
  const valueDefinition = isGraphModelLike(value) ? graphNodeDefinitionSafely(value) : undefined;
  for (const metadata of nodes) {
    if (metadata.id === value) return metadata;
    if (metadata.node === value) return metadata;
    if (!valueDefinition || !isGraphModelLike(metadata.node)) continue;
    const nodeDefinition = graphNodeDefinitionSafely(metadata.node);
    if (
      nodeDefinition &&
      (nodeDefinition.name === valueDefinition.name || nodeDefinition.tag === valueDefinition.tag)
    ) {
      return metadata;
    }
  }
  if (typeof value === "string" && aliases.includes(value)) return undefined;
  return undefined;
}

function isGraphModelLike(value: unknown): boolean {
  return typeof value === "function" || (typeof value === "object" && value !== null);
}

function graphNodeDefinitionSafely(node: unknown): GraphNodeDefinitionShim | undefined {
  try {
    return graphWorkflowDefinitionOf(node as never) as unknown as GraphNodeDefinitionShim;
  } catch {
    return undefined;
  }
}

/**
 * Spec-mandated (§4.4.9) compiler facade. Delegates to
 * {@link graphDecoratedWorkflowCompiler}, which performs the actual
 * decorated-definition to {@link GraphWorkflowDocument} mapping.
 */
export class GraphDecoratedWorkflowCompiler {
  /**
   * Compiles a decorated workflow class (or model instance, or raw
   * definition) into its canonical {@link GraphWorkflowDocument}.
   *
   * @param {GraphDecoratedWorkflowInput} workflow - The decorated workflow source to compile.
   * @param {GraphDecoratedWorkflowCompileOptions} [options] - Compile options forwarded to the facade.
   * @return {GraphWorkflowDocument} The compiled canonical document.
   * @throws {Error} When the workflow shape is invalid or a loop body fails to compile.
   */
  compile(
    workflow: GraphDecoratedWorkflowInput,
    options: GraphDecoratedWorkflowCompileOptions = {}
  ): GraphWorkflowDocument {
    return graphDecoratedWorkflowCompiler(workflow, options);
  }
}

export type { GraphWorkflowEndpoint, GraphNodeEndpoint };
