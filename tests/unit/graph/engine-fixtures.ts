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
 * Builds a catalogue with the arithmetic demo executors registered as
 * legacy executor-only (placeholder-manifest, lenient) kinds. The executors
 * follow the DECAF-50 §4.9 request contract: routed port values are read
 * from `request.inputs`.
 */
export function demoCatalogue(
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
): GraphNodeCatalogue {
  const catalogue = new GraphNodeCatalogueClass();
  for (const [kind, executor] of Object.entries(executors)) {
    catalogue.registerExecutor(kind, executor);
  }
  return catalogue;
}

/**
 * Validates a canonical document through the nine-stage gate and returns the
 * resolved workflow (throws `GraphDocumentValidationError` when invalid).
 */
export async function resolveDocument(
  document: GraphWorkflowDocument,
  catalogue: GraphNodeCatalogue = demoCatalogue()
): Promise<GraphResolvedWorkflow> {
  const validator = new GraphWorkflowDocumentValidator({ catalogue });
  return await validator.validateOrThrow(document);
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
