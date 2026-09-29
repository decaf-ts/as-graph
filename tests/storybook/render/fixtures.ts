/**
 * @module as-graph/tests/storybook/render/fixtures
 * @summary Browser-safe graph fixtures for the storybook stories.
 * @description Story-only fixtures: the built-in node manifests (resolved per
 * instance so dynamic ports such as switch cases are expanded), three canonical
 * workflow documents and their post-run feedback records. Nothing here imports
 * the execution engine (or `isolated-vm`), so the stories bundle cleanly in the
 * browser; the engine-backed equivalents live in `tests/e2e/ui`.
 */
import type {
  GraphEdgeInstance,
  GraphNodeInstance,
  GraphNodeManifest,
  GraphPortManifest,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph";
import type { GraphExecutionEvent } from "../../../src/shared/graph";
import { GRAPH_BUILT_IN_NODE_MANIFESTS } from "../../../src/node/manifests";
import { resolveGraphNodeManifest } from "../../../src/engine/catalog/GraphNodeManifestResolver";
import { graphRunViewOf, graphWorkflowViewOf } from "../../../src/shared/ui";
import type {
  GraphManifestLookup,
  GraphRunResultLike,
  GraphWorkflowView,
} from "../../../src/shared/ui";

/** All built-in node manifests, browser-safe (no engine runtime import). */
export const BUILT_IN_MANIFESTS: GraphNodeManifest[] =
  GRAPH_BUILT_IN_NODE_MANIFESTS;

/** Built-in manifests indexed by kind. */
export const BUILT_IN_MANIFESTS_BY_KIND: Record<string, GraphNodeManifest> =
  Object.fromEntries(
    BUILT_IN_MANIFESTS.map((manifest) => [manifest.kind, manifest])
  );

/**
 * Resolves the effective manifest for a node instance, expanding dynamic ports
 * (e.g. switch cases) against the instance parameters.
 *
 * @param instance - The document node instance.
 * @returns The resolved manifest, or `undefined` for an unknown kind.
 */
export function resolveManifestFor(
  instance: GraphNodeInstance
): GraphNodeManifest | undefined {
  const manifest = BUILT_IN_MANIFESTS_BY_KIND[instance.kind];
  if (!manifest) return undefined;
  return resolveGraphNodeManifest(
    manifest,
    instance.parameters ?? {}
  ) as unknown as GraphNodeManifest;
}

/** Per-instance manifest lookup consumed by the shared workflow view builder. */
export const manifestLookup: GraphManifestLookup = (instance) =>
  resolveManifestFor(instance);

/** Builds a workflow view from a document plus its optional run record. */
export function workflowViewOf(
  document: GraphWorkflowDocument,
  run?: GraphRunResultLike
): GraphWorkflowView {
  return graphWorkflowViewOf(
    document,
    manifestLookup,
    run ? graphRunViewOf(run) : undefined
  );
}

/** Builds a workflow document port. */
export function documentPort(
  id: string,
  label?: string
): GraphWorkflowDocument["inputs"][number] {
  return { id, label: label ?? id };
}

/** Builds a workflow node instance. */
export function documentNode(
  id: string,
  kind: string,
  parameters: GraphNodeInstance["parameters"] = {},
  extra: Partial<GraphNodeInstance> = {}
): GraphNodeInstance {
  return { id, kind, parameters, ...extra };
}

/** Builds a workflow edge instance. */
export function documentEdge(
  id: string,
  source: [string, string] | [string, string, string],
  target: [string, string] | [string, string, string],
  type: GraphEdgeInstance["type"] = "data"
): GraphEdgeInstance {
  return {
    id,
    type,
    source: endpointOf(source),
    target: endpointOf(target),
  };
}

function endpointOf(
  parts: [string, string] | [string, string, string]
): GraphEdgeInstance["source"] {
  if (parts[0] === "workflow") {
    return { scope: "workflow", port: parts[1] };
  }
  return { scope: "node", nodeId: parts[1], port: parts[2] ?? "" };
}

/** A code node with its `code` supplied as a literal input binding. */
function codeNode(
  id: string,
  code: string,
  extra: Partial<GraphNodeInstance> = {}
): GraphNodeInstance {
  return documentNode(id, "core.utility.code", {}, {
    ...extra,
    inputBindings: { code: { mode: "literal", value: code } },
  });
}

/** A switch node carrying its cases on both metadata and parameters. */
function switchNode(
  id: string,
  cases: Array<{ id: string; label: string; outputPort: string }>
): GraphNodeInstance {
  const metadata = { cases, defaultPort: "default", hasDefault: true };
  return documentNode(
    id,
    "core.flow.switch",
    { cases: metadata.cases, hasDefault: true },
    { metadata: { switch: metadata } }
  );
}

const START_CODE = "return ($input.data ?? 0) + 1;";
const BIG_CODE = "return $input.data * 10;";
const SMALL_CODE = "return $input.data + 100;";
const COLLECT_CODE = "return ($input.data ?? []).join('-');";
const CLASSIFY_CODE = "return $input.data >= 10 ? 'high' : 'low';";
const HIGH_CODE = "return 'HIGH:' + $input.data;";
const LOW_CODE = "return 'LOW:' + $input.data;";

const BIG_SMALL_CASES = [
  { id: "big", label: "Big", outputPort: "big" },
];

const HIGH_LOW_CASES = [
  { id: "high", label: "High", outputPort: "high" },
];

/**
 * Workflow 1: linear `code -> switch (condition) -> code`.
 */
export function linearCodeConditionCodeDocument(): GraphWorkflowDocument {
  return {
    id: "wf-linear-code-condition-code",
    name: "Linear code -> condition -> code",
    inputs: [documentPort("n")],
    outputs: [documentPort("result")],
    nodes: [
      codeNode("start", START_CODE),
      switchNode("gate", BIG_SMALL_CASES),
      codeNode("big", BIG_CODE),
      codeNode("small", SMALL_CODE),
    ],
    edges: [
      documentEdge("e1", ["workflow", "n"], ["node", "start", "data"]),
      documentEdge("e2", ["node", "start", "result"], ["node", "gate", "value"]),
      documentEdge("e3", ["node", "gate", "big"], ["node", "big", "data"]),
      documentEdge("e4", ["node", "gate", "default"], ["node", "small", "data"]),
      documentEdge("e5", ["node", "big", "result"], ["workflow", "result"]),
      documentEdge("e6", ["node", "small", "result"], ["workflow", "result"]),
    ],
  };
}

/**
 * Workflow 2 body: `code` doubling the routed loop item.
 */
function foreachBodyDocument(): GraphWorkflowDocument {
  return {
    id: "wf-foreach-body",
    name: "Foreach body",
    inputs: [documentPort("item")],
    outputs: [documentPort("result")],
    nodes: [codeNode("double", "return $item * 2;")],
    edges: [
      documentEdge("b1", ["workflow", "item"], ["node", "double", "data"]),
      documentEdge("b2", ["node", "double", "result"], ["workflow", "result"]),
    ],
  };
}

/**
 * Workflow 2: foreach loop over an array with a code body plus a collector.
 */
export function foreachWorkflowDocument(): GraphWorkflowDocument {
  return {
    id: "wf-foreach",
    name: "Foreach loop",
    inputs: [documentPort("items")],
    outputs: [documentPort("result")],
    nodes: [
      documentNode(
        "loop",
        "core.loop.foreach",
        { itemPort: "item", resultPort: "result" },
        { loop: { body: foreachBodyDocument() } }
      ),
      codeNode("collect", COLLECT_CODE),
    ],
    edges: [
      documentEdge("f1", ["workflow", "items"], ["node", "loop", "items"]),
      documentEdge("f2", ["node", "loop", "completed"], ["node", "collect", "data"]),
      documentEdge("f3", ["node", "collect", "result"], ["workflow", "result"]),
    ],
  };
}

/**
 * Workflow 3: a pinnable classifier feeding a switch with two branch codes.
 */
export function switchBranchPinningDocument(): GraphWorkflowDocument {
  return {
    id: "wf-switch-branch-pinning",
    name: "Switch branch + pinning",
    inputs: [documentPort("n")],
    outputs: [documentPort("result")],
    nodes: [
      codeNode("classify", CLASSIFY_CODE, {
        metadata: { pinnable: { enabled: true, strategy: "manual" } },
      }),
      switchNode("route", HIGH_LOW_CASES),
      codeNode("highBranch", HIGH_CODE),
      codeNode("lowBranch", LOW_CODE),
    ],
    edges: [
      documentEdge("p1", ["workflow", "n"], ["node", "classify", "data"]),
      documentEdge("p2", ["node", "classify", "result"], ["node", "route", "value"]),
      documentEdge("p3", ["node", "route", "high"], ["node", "highBranch", "data"]),
      documentEdge("p4", ["node", "route", "default"], ["node", "lowBranch", "data"]),
      documentEdge("p5", ["node", "highBranch", "result"], ["workflow", "result"]),
      documentEdge("p6", ["node", "lowBranch", "result"], ["workflow", "result"]),
    ],
  };
}

/** Builds a run event for a node. */
export function nodeEvent(
  runId: string,
  nodeId: string,
  sequence: number,
  type: GraphExecutionEventType,
  status?: GraphExecutionStatus,
  payload?: unknown
): GraphExecutionEvent {
  return {
    id: `${runId}:${nodeId}:${sequence}`,
    sequence,
    runId,
    workflowId: runId,
    type,
    timestamp: new Date(0),
    nodeId,
    path: [],
    status,
    payload,
  };
}

/** Post-run feedback for workflow 1 (`n = 7` -> `80`). */
export function linearRunRecord(): GraphRunResultLike {
  const runId = "run-linear";
  return {
    runId,
    workflowId: "wf-linear-code-condition-code",
    status: GraphExecutionStatus.SUCCEEDED,
    outputs: { result: 80 },
    nodeResults: {
      start: {
        nodeId: "start",
        status: GraphExecutionStatus.SUCCEEDED,
        inputs: { code: START_CODE, data: 7 },
        outputs: { result: 8 },
      },
      gate: {
        nodeId: "gate",
        status: GraphExecutionStatus.SUCCEEDED,
        inputs: { value: 8 },
        outputs: { big: 8 },
      },
      big: {
        nodeId: "big",
        status: GraphExecutionStatus.SUCCEEDED,
        inputs: { code: BIG_CODE, data: 8 },
        outputs: { result: 80 },
      },
      small: {
        nodeId: "small",
        status: GraphExecutionStatus.SKIPPED,
        inputs: {},
        outputs: {},
      },
    },
    events: [
      nodeEvent(runId, "start", 1, GraphExecutionEventType.NODE_STARTED, GraphExecutionStatus.RUNNING),
      nodeEvent(runId, "start", 2, GraphExecutionEventType.NODE_COMPLETED, GraphExecutionStatus.SUCCEEDED),
      nodeEvent(runId, "gate", 3, GraphExecutionEventType.NODE_COMPLETED, GraphExecutionStatus.SUCCEEDED),
      nodeEvent(runId, "big", 4, GraphExecutionEventType.NODE_COMPLETED, GraphExecutionStatus.SUCCEEDED),
      nodeEvent(runId, "small", 5, GraphExecutionEventType.NODE_SKIPPED, GraphExecutionStatus.SKIPPED),
    ],
  };
}

/** Post-run feedback for workflow 2 (items `[1,2,3]` -> `"2-4-6"`). */
export function foreachRunRecord(): GraphRunResultLike {
  const runId = "run-foreach";
  return {
    runId,
    workflowId: "wf-foreach",
    status: GraphExecutionStatus.SUCCEEDED,
    outputs: { result: "2-4-6" },
    nodeResults: {
      loop: {
        nodeId: "loop",
        status: GraphExecutionStatus.SUCCEEDED,
        inputs: { items: [1, 2, 3] },
        outputs: { results: [2, 4, 6], completed: [2, 4, 6], iterations: 3 },
      },
      collect: {
        nodeId: "collect",
        status: GraphExecutionStatus.SUCCEEDED,
        inputs: { code: COLLECT_CODE, data: [2, 4, 6] },
        outputs: { result: "2-4-6" },
      },
    },
    events: [
      nodeEvent(runId, "loop", 1, GraphExecutionEventType.NODE_STARTED, GraphExecutionStatus.RUNNING),
      nodeEvent(runId, "loop", 2, GraphExecutionEventType.NODE_COMPLETED, GraphExecutionStatus.SUCCEEDED),
      nodeEvent(runId, "collect", 3, GraphExecutionEventType.NODE_COMPLETED, GraphExecutionStatus.SUCCEEDED),
    ],
  };
}

/** Post-run feedback for workflow 3 (`n = 12` -> `HIGH:high`, low branch skipped). */
export function switchBranchRunRecord(): GraphRunResultLike {
  const runId = "run-switch-branch";
  return {
    runId,
    workflowId: "wf-switch-branch-pinning",
    status: GraphExecutionStatus.SUCCEEDED,
    outputs: { result: "HIGH:high" },
    nodeResults: {
      classify: {
        nodeId: "classify",
        status: GraphExecutionStatus.SUCCEEDED,
        inputs: { code: CLASSIFY_CODE, data: 12 },
        outputs: { result: "high" },
      },
      route: {
        nodeId: "route",
        status: GraphExecutionStatus.SUCCEEDED,
        inputs: { value: "high" },
        outputs: { high: "high" },
      },
      highBranch: {
        nodeId: "highBranch",
        status: GraphExecutionStatus.SUCCEEDED,
        inputs: { code: HIGH_CODE, data: "high" },
        outputs: { result: "HIGH:high" },
      },
      lowBranch: {
        nodeId: "lowBranch",
        status: GraphExecutionStatus.SKIPPED,
        inputs: {},
        outputs: {},
      },
    },
    events: [
      nodeEvent(runId, "classify", 1, GraphExecutionEventType.NODE_COMPLETED, GraphExecutionStatus.SUCCEEDED),
      nodeEvent(runId, "route", 2, GraphExecutionEventType.NODE_COMPLETED, GraphExecutionStatus.SUCCEEDED),
      nodeEvent(runId, "highBranch", 3, GraphExecutionEventType.NODE_COMPLETED, GraphExecutionStatus.SUCCEEDED),
      nodeEvent(runId, "lowBranch", 4, GraphExecutionEventType.NODE_SKIPPED, GraphExecutionStatus.SKIPPED),
    ],
  };
}

/** The port manifests for a resolved node, split by direction. */
export function portsOf(
  manifest: GraphNodeManifest
): { inputs: GraphPortManifest[]; outputs: GraphPortManifest[] } {
  return { inputs: manifest.inputs, outputs: manifest.outputs };
}
