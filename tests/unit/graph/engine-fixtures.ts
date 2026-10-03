/**
 * @module as-graph/tests/unit/graph/fixtures
 * @summary Test fixtures for graph execution engine unit tests.
 */
import type {
  GraphNodeDefinition,
  GraphPortDefinition,
  GraphWorkflowDefinition,
  GraphWorkflowRelationMetadata,
  GraphWorkflowNodeMetadata,
} from "../../../src/shared/graph";
import { PortDirection } from "../../../src/shared/graph";

/**
 * Builds a minimal port definition.
 */
export function port(
  name: string,
  direction: PortDirection
): GraphPortDefinition {
  return {
    property: name,
    direction,
    name,
    label: name,
    required: false,
    hidden: false,
  };
}

/**
 * Builds a minimal node definition with the given input/output port names.
 */
export function nodeDef(
  name: string,
  kind: string,
  inputPorts: string[] = [],
  outputPorts: string[] = []
): GraphNodeDefinition {
  return {
    name,
    tag: name,
    kind,
    labels: [],
    ports: [
      ...inputPorts.map((p) => port(p, PortDirection.INPUT)),
      ...outputPorts.map((p) => port(p, PortDirection.OUTPUT)),
    ],
  };
}

/**
 * Builds a workflow node metadata entry referencing a definition.
 */
export function workflowNode(
  id: string,
  kind: string,
  definition?: GraphNodeDefinition
): GraphWorkflowNodeMetadata {
  return {
    id,
    kind,
    label: id,
    node: definition,
  };
}

/**
 * Builds a relation metadata entry.
 */
export function relation(
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string
): GraphWorkflowRelationMetadata {
  return { source, sourcePort, target, targetPort };
}

/**
 * Builds a linear two-node workflow:
 *   workflow.input -> adder -> multiplier -> workflow.output
 */
export function linearWorkflow(): GraphWorkflowDefinition {
  const adderDef = nodeDef("adder", "math.add", ["a", "b"], ["sum"]);
  const multiplierDef = nodeDef("multiplier", "math.multiply", ["x"], ["product"]);

  return {
    name: "linear-wf",
    tag: "linear-wf",
    kind: "workflow",
    labels: [],
    ports: [],
    inputs: [port("a", PortDirection.INPUT), port("b", PortDirection.INPUT)],
    outputs: [port("result", PortDirection.OUTPUT)],
    nodes: [
      workflowNode("adder", "math.add", adderDef),
      workflowNode("multiplier", "math.multiply", multiplierDef),
    ],
    relations: [
      relation("workflow", "a", "adder", "a"),
      relation("workflow", "b", "adder", "b"),
      relation("adder", "sum", "multiplier", "x"),
      relation("multiplier", "product", "workflow", "result"),
    ],
    workflow: {
      inputs: [port("a", PortDirection.INPUT), port("b", PortDirection.INPUT)],
      outputs: [port("result", PortDirection.OUTPUT)],
    },
  };
}

/**
 * Builds a cyclic workflow (adder -> multiplier -> adder) to test cycle detection.
 */
export function cyclicWorkflow(): GraphWorkflowDefinition {
  const adderDef = nodeDef("adder", "math.add", ["a"], ["sum"]);
  const multiplierDef = nodeDef("multiplier", "math.multiply", ["x"], ["product"]);

  return {
    name: "cyclic-wf",
    tag: "cyclic-wf",
    kind: "workflow",
    labels: [],
    ports: [],
    inputs: [],
    outputs: [],
    nodes: [
      workflowNode("adder", "math.add", adderDef),
      workflowNode("multiplier", "math.multiply", multiplierDef),
    ],
    relations: [
      relation("adder", "sum", "multiplier", "x"),
      relation("multiplier", "product", "adder", "a"),
    ],
    workflow: { inputs: [], outputs: [] },
  };
}

// ---------------------------------------------------------------------------
// DECAF-50 canonical document fixtures (P3 planner/engine contract).
// ---------------------------------------------------------------------------

import type {
  GraphEdgeInstance,
  GraphEndpoint,
  GraphNodeInstance,
  GraphWorkflowDocument,
  GraphWorkflowPortInstance,
} from "../../../src/shared/graph";
import type { GraphResolvedNodeManifest } from "../../../src/shared/graph";
import type { GraphNodeCatalogue } from "../../../src/engine/catalog/GraphNodeCatalogue";
import { GraphNodeCatalogue as GraphNodeCatalogueClass } from "../../../src/engine/catalog/GraphNodeCatalogue";
import type { GraphNodeExecutor } from "../../../src/engine/execution/GraphNodeExecutor";
import type { GraphExecutionContext } from "../../../src/engine/execution/GraphExecutionContext";
import { graphNodeConfig } from "../../../src/node/base";
import type { GraphNodeClass } from "../../../src/node/base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../src/engine/types";
import type {
  GraphResolvedEdgeInstance,
  GraphResolvedWorkflow,
} from "../../../src/engine/validation/GraphResolvedWorkflow";
import {
  GraphWorkflowDocumentValidator,
} from "../../../src/engine/validation/GraphWorkflowDocumentValidator";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import type { GraphExecutionEngineConfig } from "../../../src/engine/execution/GraphExecutionEngine";
import { createRamGraphAdapter } from "../../../src/ram";
import { Adapter, Context } from "@decaf-ts/core";
import { IsolatedVmCodeSandboxEvaluator } from "../../../src/engine/execution/IsolatedVmCodeSandboxEvaluator";
import type { IsolatedVmCodeSandboxEvaluatorConfig } from "../../../src/engine/execution/IsolatedVmCodeSandboxEvaluator";
import { Injectables } from "@decaf-ts/injectable-decorators";

/**
 * Returns a fresh {@link GraphNodeCatalogue}. `GraphNodeCatalogue` is a
 * `@service()` singleton, so `new GraphNodeCatalogue()` would otherwise return
 * the same shared instance across tests; reset the injectable first so each call
 * gets an isolated catalogue.
 */
export function resetGraphInjectables(): void {
  const registry = Injectables.getRegistry() as unknown as {
    cache?: Record<string | symbol, { instance?: unknown }>;
  };
  const cache = registry.cache;
  if (!cache) return;
  for (const key of Object.getOwnPropertySymbols(cache)) {
    if (key.toString().includes("GraphNodeCatalogue")) {
      const entry = cache[key];
      if (entry && typeof entry === "object") entry.instance = undefined;
    }
  }
}

/**
 * Returns an isolated {@link GraphNodeCatalogue}. Pairs with
 * {@link resetGraphInjectables}, which must run first so the `@service()`
 * singleton is re-instantiated instead of reused across tests.
 */
export function freshCatalogue(): GraphNodeCatalogue {
  resetGraphInjectables();
  return new GraphNodeCatalogueClass();
}

/**
 * Clears the process-global Decaf adapter cache. The `@service()` singleton
 * catalogue and the eagerly-created `RamAdapter` in `createDemoEngineConfig`
 * leak across Nest module bootstraps; tests that boot the graph module more than
 * once must reset both registries first so each bootstrap starts clean.
 */
export function resetGraphAdapters(): void {
  const adapter = Adapter as unknown as {
    _cache?: Record<string, unknown>;
    _currentFlavour?: string;
  };
  const cache = adapter._cache;
  if (cache) {
    for (const alias of Object.keys(cache)) {
      delete cache[alias];
    }
  }
  adapter._currentFlavour = undefined;
}

/**
 * Unregisters only the graph value adapter alias (`as-graph-ram`) that
 * `createDemoEngineConfig` eagerly registers on every module bootstrap, leaving
 * the ambient `ram` adapter that a host `DecafModule` installed in place. Use
 * this when a suite boots the graph module repeatedly and must reuse the host
 * adapter across bootstraps.
 */
export function resetGraphValueAdapter(): void {
  Adapter.unregister("as-graph-ram");
}

/**
 * Builds a minimal workflow port instance for a document.
 */
export function documentPort(
  id: string,
  extra: Partial<GraphWorkflowPortInstance> = {}
): GraphWorkflowPortInstance {
  return { id, ...extra };
}

/**
 * Builds a canonical node instance for a document.
 */
export function documentNode(
  id: string,
  kind: string,
  parameters: Record<string, unknown> = {},
  extra: Partial<GraphNodeInstance> = {}
): GraphNodeInstance {
  return { id, kind, parameters, ...extra };
}

/**
 * Builds a canonical edge instance. Endpoints are `[scope, nodeId, port]`
 * triples with scope `"node"` or `"workflow"`.
 */
export function documentEdge(
  id: string,
  source: ["node", string, string] | ["workflow", string],
  target: ["node", string, string] | ["workflow", string],
  type: "data" | "connection" = "data"
): GraphEdgeInstance {
  const endpoint = (
    value: ["node", string, string] | ["workflow", string]
  ): GraphEndpoint =>
    value[0] === "node"
      ? { scope: "node", nodeId: value[1], port: value[2] }
      : { scope: "workflow", port: value[1] };
  return { id, type, source: endpoint(source), target: endpoint(target) };
}

/**
 * Builds a linear two-node canonical document:
 *   workflow.a/b -> adder -> multiplier -> workflow.result
 */
export function linearDocument(): GraphWorkflowDocument {
  return {
    id: "linear-wf",
    name: "linear-wf",
    inputs: [documentPort("a"), documentPort("b")],
    outputs: [documentPort("result")],
    nodes: [
      documentNode("adder", "math.add"),
      documentNode("multiplier", "math.multiply"),
    ],
    edges: [
      documentEdge("e1", ["workflow", "a"], ["node", "adder", "a"]),
      documentEdge("e2", ["workflow", "b"], ["node", "adder", "b"]),
      documentEdge("e3", ["node", "adder", "sum"], ["node", "multiplier", "x"]),
      documentEdge("e4", ["node", "multiplier", "product"], ["workflow", "result"]),
    ],
  };
}

/**
 * Builds a cyclic canonical document (adder -> multiplier -> adder).
 */
export function cyclicDocument(): GraphWorkflowDocument {
  return {
    id: "cyclic-wf",
    name: "cyclic-wf",
    inputs: [],
    outputs: [],
    nodes: [
      documentNode("adder", "math.add"),
      documentNode("multiplier", "math.multiply"),
    ],
    edges: [
      documentEdge("e1", ["node", "adder", "sum"], ["node", "multiplier", "x"]),
      documentEdge("e2", ["node", "multiplier", "product"], ["node", "adder", "a"]),
    ],
  };
}

/**
 * Builds a minimal {@link GraphNodeExecutionRequest} for invoking executors
 * directly under the DECAF-50 §4.9 request contract (post-cutover default):
 * port values live in `inputs`, node configuration in `parameters`.
 */
export function nodeExecutionRequest(
  inputs: Record<string, unknown>,
  overrides: Partial<GraphNodeExecutionRequest> = {}
): GraphNodeExecutionRequest {
  return {
    nodeId: "TestNode",
    kind: "test.kind",
    inputs: inputs as GraphExecutionValues,
    parameters: {},
    credentials: {},
    ...overrides,
  };
}

/**
 * Instantiates a built-in node class with its configuration hydrated by the
 * constructor (`Model.fromModel`), then invokes its **instance** `execute` method —
 * the DECAF-50 §4.26 R2-1 executor contract used by the built-in
 * registrations.
 *
 * The node instance is hydrated from the flattened `context.node` configuration
 * with the engine-resolved `request.parameters` merged on top and the persisted
 * user-defined `state` re-applied last — matching
 * `GraphBuiltInRegistrations.executorOf` exactly. The engine resolves
 * `GraphValueTemplate` user properties into `request.parameters` at execution
 * time (DECAF-32 §22.4), so the harness must let the resolved values win over the
 * raw persisted ones for templates to reach the node. Persisted `@state()` values
 * are re-applied last so they always win over a same-named parameter (DECAF-50
 * §4.5 item 3, merge order `metadata` → `parameters` → `state`).
 */
export function executeNode(
  nodeClass: GraphNodeClass,
  request: GraphNodeExecutionRequest,
  context: GraphExecutionContext
): GraphExecutionValues | Promise<GraphExecutionValues> {
  const instance = nodeClass.instantiate({
    ...graphNodeConfig(context.node),
    ...(request.parameters as Record<string, unknown>),
    ...((context.node.state as Record<string, unknown>) ?? {}),
  });
  return instance.execute(request, context);
}

/**
 * Wraps a built-in node class as a `GraphNodeExecutor` whose `execute`
 * instantiates + hydrates the class per call (matching the built-in
 * registration's executor), so tests can drive a node class through the same
 * instance-`execute` contract as production.
 */
export function nodeExecutor(nodeClass: GraphNodeClass): GraphNodeExecutor {
  return {
    execute: (request, context) =>
      executeNode(nodeClass, request, context),
  };
}

/**
 * Builds a catalogue with the arithmetic demo executors registered as
 * legacy executor-only (placeholder-manifest, lenient) kinds. The executors
 * follow the DECAF-50 §4.9 request contract: routed port values are read
 * from `request.inputs`.
 */
export async function demoCatalogue(
  executors: Record<string, GraphNodeExecutor> = {
    "math.add": {
      execute: (request) => ({
        sum: Number(request.inputs.a) + Number(request.inputs.b),
      }),
    },
    "math.multiply": {
      execute: (request) => ({ product: Number(request.inputs.x) * 2 }),
    },
  }
): Promise<GraphNodeCatalogue> {
  const catalogue = freshCatalogue();
  const ctx = new Context();
  for (const [kind, executor] of Object.entries(executors)) {
    catalogue.registerExecutor(kind, executor, ctx);
  }
  return catalogue;
}

/**
 * Validates a canonical document through the nine-stage gate and returns the
 * resolved workflow (throws `GraphDocumentValidationError` when invalid).
 */
export async function resolveDocument(
  document: GraphWorkflowDocument,
  catalogue?: GraphNodeCatalogue
): Promise<GraphResolvedWorkflow> {
  const resolvedCatalogue = catalogue ?? (await demoCatalogue());
  const validator = new GraphWorkflowDocumentValidator({
    catalogue: resolvedCatalogue,
  });
  return await validator.validateOrThrow(document, 0, new Context());
}

/**
 * Boots an {@link IsolatedVmCodeSandboxEvaluator} as a Decaf `ClientBasedService`
 * and returns the initialized instance. Tests must boot the evaluator before calling
 * `evaluate`; this helper keeps that boilerplate in one place.
 */
export async function bootCodeSandboxEvaluator(
  config: IsolatedVmCodeSandboxEvaluatorConfig = {}
): Promise<IsolatedVmCodeSandboxEvaluator> {
  const evaluator = new IsolatedVmCodeSandboxEvaluator();
  await evaluator.boot(config);
  return evaluator;
}

let ramAdapterCounter = 0;

/**
 * Boots a {@link GraphExecutionEngine} as a Decaf `ClientBasedService` and
 * returns the initialized instance. Tests must boot the engine before observing or
 * executing; this helper keeps that boilerplate in one place. Falls back to a
 * fresh `RamAdapter` alias when `config.valueAdapter` is not supplied.
 */
export async function bootEngine(
  config: GraphExecutionEngineConfig
): Promise<GraphExecutionEngine> {
  const engine = new GraphExecutionEngine();
  const valueAdapter =
    config.valueAdapter ??
    (await createRamGraphAdapter(`as-graph-ram-${ramAdapterCounter++}`));
  await engine.boot({ ...config, valueAdapter });
  return engine;
}

/**
 * Builds a minimal resolved manifest for hand-constructed resolved workflows.
 */
export function minimalManifest(
  kind: string,
  inputPorts: string[] = [],
  outputPorts: string[] = []
): GraphResolvedNodeManifest {
  return {
    kind,
    display: { name: kind },
    inputs: inputPorts.map((id) => ({ id, label: id, direction: "input" })),
    outputs: outputPorts.map((id) => ({ id, label: id, direction: "output" })),
    parameters: [],
  };
}

/**
 * Hand-builds a `GraphResolvedWorkflow` without running the validation gate.
 * Only for planner-level tests that must bypass validation (e.g. cycle
 * detection inside the planner itself).
 */
export function handResolvedWorkflow(
  document: GraphWorkflowDocument,
  nodes: { id: string; kind: string; inputs?: string[]; outputs?: string[] }[],
  edges: [id: string, from: string, fromPort: string, to: string, toPort: string][]
): GraphResolvedWorkflow {
  const resolvedNodes = nodes.map((node) => ({
    instance: { id: node.id, kind: node.kind, parameters: {} },
    manifest: minimalManifest(node.kind, node.inputs, node.outputs),
    executor: { execute: () => ({}) },
  }));
  const nodeById = new Map(resolvedNodes.map((node) => [node.instance.id, node]));
  const resolvedEdges: GraphResolvedEdgeInstance[] = edges.map(
    ([id, from, fromPort, to, toPort]) => ({
      id,
      type: "data" as const,
      sourceNodeId: from,
      sourcePort: fromPort,
      targetNodeId: to,
      targetPort: toPort,
      edge: {
        id,
        type: "data" as const,
        source:
          from === "$workflow"
            ? { scope: "workflow" as const, port: fromPort }
            : { scope: "node" as const, nodeId: from, port: fromPort },
        target:
          to === "$workflow"
            ? { scope: "workflow" as const, port: toPort }
            : { scope: "node" as const, nodeId: to, port: toPort },
      },
    })
  );
  const incomingByNode = new Map<string, GraphResolvedEdgeInstance[]>();
  const outgoingByNode = new Map<string, GraphResolvedEdgeInstance[]>();
  for (const edge of resolvedEdges) {
    if (edge.targetNodeId !== "$workflow") {
      const list = incomingByNode.get(edge.targetNodeId) ?? [];
      list.push(edge);
      incomingByNode.set(edge.targetNodeId, list);
    }
    if (edge.sourceNodeId !== "$workflow") {
      const list = outgoingByNode.get(edge.sourceNodeId) ?? [];
      list.push(edge);
      outgoingByNode.set(edge.sourceNodeId, list);
    }
  }
  return {
    document,
    nodes: resolvedNodes,
    edges: resolvedEdges,
    nodeById,
    incomingByNode,
    outgoingByNode,
  };
}
