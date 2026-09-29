/**
 * @jest-environment jsdom
 *
 * @module as-graph/tests/e2e/ui/full-workflows.test
 * @summary SAA-1931 evidence: full-workflow UI e2e — the real migrated backend
 * engine executes three workflows and the shared graph view models render the run
 * through the test DOM renderer, asserting every node's displayed intermediate
 * inputs/outputs and run-state feedback.
 * @description Drives the migrated `GraphExecutionEngine` with real built-in nodes
 * over the isolated-vm sandbox, then projects the engine's `GraphExecutionResult`
 * through the shared `graphWorkflowViewOf` + run view builders and renders it with
 * the test DOM renderer. Unlike the storybook stories (browser-safe fixtures),
 * this is the end-to-end path: engine -> shared view model -> DOM, so the UI
 * contract is verified against real engine output.
 */
import { afterEach, describe, expect, it } from "@jest/globals";

import type {
  GraphEdgeInstance,
  GraphEndpoint,
  GraphJsonValue,
  GraphNodeInstance,
  GraphWorkflowDocument,
  GraphWorkflowPortInstance,
} from "../../../src/shared/graph";
import { CODE_GRAPH_NODE_MANIFEST, CodeNode } from "../../../src/node";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { IsolatedVmCodeSandboxEvaluator } from "../../../src/engine/execution/IsolatedVmCodeSandboxEvaluator";
import { GraphNodeCatalogue } from "../../../src/engine/catalog/GraphNodeCatalogue";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { registerBuiltInGraphNodes } from "../../../src/engine/catalog/GraphBuiltInRegistrations";
import { defineGraphNode } from "../../../src/engine/catalog/GraphNodeRegistration";
import { GraphWorkflowDocumentValidator } from "../../../src/engine/validation/GraphWorkflowDocumentValidator";
import {
  assertGraph,
  clickGraphNode,
  graphEdgeElement,
  graphNodeElement,
  graphNodeIoElement,
  graphPortElement,
  nodeRunInputs,
  nodeRunOutputs,
  renderGraphWorkflow,
} from "../../storybook/render/dom";
import { workflowViewOf } from "../../storybook/render/fixtures";

/** A switch case condition (structural mirror of `SwitchCaseMetadata`). */
interface SwitchCaseMetadata {
  /** Case identifier. */
  id: string;
  /** Case label. */
  label?: string;
  /** Output port the case routes to. */
  outputPort: string;
  /** Case predicate. */
  condition: {
    /** Comparison operator. */
    op: string;
    /** Left operand path. */
    left: { path: string };
    /** Right operand constant. */
    right: { const: GraphJsonValue };
  };
}

/** A switch node metadata payload (structural mirror of `SwitchNodeMetadata`). */
interface SwitchNodeMetadata {
  /** Switch cases. */
  cases: SwitchCaseMetadata[];
  /** Default output port. */
  defaultPort: string;
  /** Whether the switch has a default branch. */
  hasDefault: boolean;
}


const START_CODE = "return ($input.data ?? 0) + 1;";
const BIG_CODE = "return $input.data * 10;";
const SMALL_CODE = "return $input.data + 100;";
const DOUBLE_CODE = "return $item * 2;";
const COLLECT_CODE = "return ($input.data ?? []).join('-');";
const CLASSIFY_CODE = "return $input.data >= 10 ? 'high' : 'low';";
const HIGH_CODE = "return 'HIGH:' + $input.data;";
const LOW_CODE = "return 'LOW:' + $input.data;";

/** Builds a workflow boundary port instance. */
function documentPort(id: string): GraphWorkflowPortInstance {
  return { id };
}

/** Builds a canonical node instance. */
function documentNode(
  id: string,
  kind: string,
  parameters: Record<string, GraphJsonValue> = {},
  extra: Partial<GraphNodeInstance> = {}
): GraphNodeInstance {
  return { id, kind, parameters, ...extra };
}

/** Builds a canonical edge instance from endpoint triples. */
function documentEdge(
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

/** Validates a canonical document and returns the resolved workflow. */
async function resolveDocument(
  document: GraphWorkflowDocument,
  catalogue: GraphNodeCatalogue
) {
  const validator = new GraphWorkflowDocumentValidator({ catalogue });
  return await validator.validateOrThrow(document);
}

/**
 * Builds an engine backed by the built-in node catalogue and the isolated-vm
 * code sandbox, mirroring how the backend wires the migrated engine.
 */
function buildEngine(): {
  engine: GraphExecutionEngine;
  catalogue: GraphNodeCatalogue;
} {
  const catalogue = new GraphNodeCatalogue();
  const engine = new GraphExecutionEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    codeSandboxEvaluator: new IsolatedVmCodeSandboxEvaluator(),
  });
  registerBuiltInGraphNodes(catalogue);
  catalogue.register(
    defineGraphNode({
      manifest: {
        ...CODE_GRAPH_NODE_MANIFEST,
        inputs: CODE_GRAPH_NODE_MANIFEST.inputs.map((port) =>
          port.id === "code" ? { ...port, schema: { type: "string" } } : port
        ),
      },
      executor: {
        execute: (request, context) => CodeNode.execute(request, context),
      },
    }),
    { replace: true }
  );
  return { engine, catalogue };
}

/** Builds a `core.utility.code` node with a literal `code` input binding. */
function codeNode(
  id: string,
  code: string,
  extra: Partial<GraphNodeInstance> = {}
) {
  return documentNode(id, "core.utility.code", {}, {
    ...extra,
    inputBindings: {
      code: { mode: "literal", value: code },
    },
  });
}

/** Builds a switch node carrying its cases on metadata and parameters. */
function switchNode(
  id: string,
  cases: SwitchNodeMetadata["cases"]
): ReturnType<typeof documentNode> {
  const metadata: SwitchNodeMetadata = {
    cases,
    defaultPort: "default",
    hasDefault: true,
  };
  return documentNode(
    id,
    "core.flow.switch",
    {
      cases: metadata.cases as unknown as GraphJsonValue,
      hasDefault: true,
    },
    { metadata: { switch: metadata as unknown as GraphJsonValue } }
  );
}

const BIG_SMALL_CASES: SwitchNodeMetadata["cases"] = [
  {
    id: "big",
    label: "Big",
    outputPort: "big",
    condition: { op: "gte", left: { path: "value" }, right: { const: 5 } },
  },
];

const HIGH_LOW_CASES: SwitchNodeMetadata["cases"] = [
  {
    id: "high",
    label: "High",
    outputPort: "high",
    condition: { op: "eq", left: { path: "value" }, right: { const: "high" } },
  },
];

/** Workflow 1: linear `code -> switch (condition) -> code`. */
function linearDocument(): GraphWorkflowDocument {
  return {
    id: "wf-linear-code-condition-code",
    name: "wf-linear-code-condition-code",
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

/** Workflow 2 body: `code` doubling the routed loop item. */
function foreachBodyDocument(): GraphWorkflowDocument {
  return {
    id: "wf-foreach-body",
    name: "wf-foreach-body",
    inputs: [documentPort("item")],
    outputs: [documentPort("result")],
    nodes: [codeNode("double", DOUBLE_CODE)],
    edges: [
      documentEdge("b1", ["workflow", "item"], ["node", "double", "data"]),
      documentEdge("b2", ["node", "double", "result"], ["workflow", "result"]),
    ],
  };
}

/** Workflow 2: foreach loop with a code body plus a downstream collector. */
function foreachDocument(): GraphWorkflowDocument {
  return {
    id: "wf-foreach",
    name: "wf-foreach",
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

/** Workflow 3: pinnable classifier -> switch -> branch code nodes. */
function switchBranchDocument(): GraphWorkflowDocument {
  return {
    id: "wf-switch-branch-pinning",
    name: "wf-switch-branch-pinning",
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

/** Renders a workflow document plus its engine result into the test DOM. */
function renderResult(
  workflow: GraphWorkflowDocument,
  result: unknown
): HTMLElement {
  const view = workflowViewOf(workflow, result as never);
  const element = renderGraphWorkflow(view);
  window.document.body.appendChild(element);
  return element;
}

afterEach(() => {
  window.document.body.innerHTML = "";
});

describe("as-graph e2e UI — engine -> shared view -> DOM (SAA-1931)", () => {
  it("renders the linear code -> switch -> code workflow and its real per-node intermediate values", async () => {
    const { engine, catalogue } = buildEngine();
    const workflow = linearDocument();
    await resolveDocument(workflow, catalogue);

    const result = await engine.execute(workflow, { n: 7 });
    const canvas = renderResult(workflow, result);

    expect(graphNodeElement(canvas, "start")?.getAttribute("data-kind")).toBe(
      "core.utility.code"
    );
    expect(graphNodeElement(canvas, "gate")?.getAttribute("data-kind")).toBe(
      "core.flow.switch"
    );
    expect(
      graphEdgeElement(canvas, "e2")?.getAttribute("data-edge-source")
    ).toBe("node:start:result");
    expect(
      graphEdgeElement(canvas, "e4")?.getAttribute("data-edge-target")
    ).toBe("node:small:data");

    assertGraph(
      graphPortElement(canvas, "gate", "output", "big"),
      "the switch case port 'big' is rendered"
    );
    assertGraph(
      graphPortElement(canvas, "gate", "output", "default"),
      "the switch default port is rendered"
    );

    expect(
      canvas.querySelector("[data-run-status]")?.getAttribute("data-run-status")
    ).toBe("succeeded");

    expect(graphNodeElement(canvas, "start")?.getAttribute("data-state")).toBe(
      "succeeded"
    );
    expect(graphNodeElement(canvas, "small")?.getAttribute("data-state")).toBe(
      "skipped"
    );
    expect(nodeRunInputs(canvas, "start")).toEqual(result.nodeResults.start.inputs);
    expect(nodeRunOutputs(canvas, "big")).toEqual(
      result.nodeResults.big.outputs
    );
    expect(nodeRunOutputs(canvas, "small")).toEqual({});

    clickGraphNode(canvas, "big");
    expect(
      graphNodeElement(canvas, "big")?.getAttribute("data-selected")
    ).toBe("true");
  });

  it("renders the foreach workflow with per-iteration loop values and the collector output", async () => {
    const { engine, catalogue } = buildEngine();
    const workflow = foreachDocument();
    await resolveDocument(workflow, catalogue);

    const result = await engine.execute(workflow, { items: [1, 2, 3] });
    const canvas = renderResult(workflow, result);

    expect(graphNodeElement(canvas, "loop")?.getAttribute("data-kind")).toBe(
      "core.loop.foreach"
    );
    expect(graphNodeElement(canvas, "collect")?.getAttribute("data-state")).toBe(
      "succeeded"
    );
    expect(nodeRunOutputs(canvas, "loop")).toEqual(
      result.nodeResults.loop.outputs
    );
    expect(nodeRunInputs(canvas, "collect")).toEqual(
      result.nodeResults.collect.inputs
    );
    expect(nodeRunOutputs(canvas, "collect")).toEqual({ result: "2-4-6" });
  });

  it("renders the switch-branch workflow with a skipped branch and the routed output", async () => {
    const { engine, catalogue } = buildEngine();
    const workflow = switchBranchDocument();
    await resolveDocument(workflow, catalogue);

    const result = await engine.execute(workflow, { n: 12 });
    const canvas = renderResult(workflow, result);

    expect(
      graphNodeIoElement(canvas, "classify")?.getAttribute("data-node-io-state")
    ).toBe("succeeded");
    expect(nodeRunInputs(canvas, "highBranch")).toEqual(
      result.nodeResults.highBranch.inputs
    );
    expect(
      graphNodeElement(canvas, "lowBranch")?.getAttribute("data-state")
    ).toBe("skipped");
    expect(
      graphPortElement(canvas, "route", "output", "high")
    ).not.toBeNull();
    expect(nodeRunOutputs(canvas, "highBranch")).toEqual({
      result: "HIGH:high",
    });
    expect(
      canvas.querySelector('[data-run-outputs]')?.textContent
    ).toContain("HIGH:high");
  });
});
