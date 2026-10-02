/**
 * @module as-graph/tests/integration/graph/engine-workflows.test
 * @summary SAA-1930 evidence: end-to-end integration workflows run through the
 * migrated backend graph engine, asserting both the workflow outputs and the
 * per-node intermediate inputs/outputs.
 * @description Drives the migrated `GraphExecutionEngine` with real built-in nodes
 * (`core.utility.code`, `core.flow.switch`, `core.loop.foreach`) over the
 * isolated-vm sandbox evaluator. Three distinct workflows are exercised:
 * (1) linear code -> switch condition -> code, (2) foreach loop with a code body
 * plus a downstream collector, and (3) switch branch routing with engine cache
 * pinning. Each workflow asserts the workflow output and the intermediate
 * `inputs`/`outputs` recorded for every executed node (and skipped nodes where a
 * branch was not selected).
 */
import { describe, it, expect } from "@jest/globals";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import {
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
  CodeNode,
} from "../../../src/node";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphNodeCatalogue } from "../../../src/engine/catalog/GraphNodeCatalogue";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { registerBuiltInGraphNodes } from "../../../src/engine/catalog/GraphBuiltInRegistrations";
import { defineGraphNode } from "../../../src/engine/catalog/GraphNodeRegistration";
import { GraphExecutionPlanner } from "../../../src/engine/planning/GraphExecutionPlanner";
import type { SwitchNodeMetadata } from "../../../src/node/flow/switch/node";
import {
  bootCodeSandboxEvaluator,
  bootEngine,
  documentEdge,
  documentNode,
  documentPort,
  executeNode,
  freshCatalogue,
  resolveDocument,
} from "../../unit/graph/engine-fixtures";

const CODE_GRAPH_NODE_MANIFEST =
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND["core.utility.code"];

const START_CODE = "return ($input.data ?? 0) + 1;";
const BIG_CODE = "return $input.data * 10;";
const SMALL_CODE = "return $input.data + 100;";
const DOUBLE_CODE = "return $item * 2;";
const COLLECT_CODE = "return ($input.data ?? []).join('-');";
const CLASSIFY_CODE = "return $input.data >= 10 ? 'high' : 'low';";
const HIGH_CODE = "return 'HIGH:' + $input.data;";
const LOW_CODE = "return 'LOW:' + $input.data;";

/**
 * Builds an engine backed by the built-in node catalogue and the isolated-vm
 * code sandbox evaluator, mirroring how the backend wires the migrated engine.
 *
 * The compiled `code` port schema is a decaf `String` model, which rejects
 * string literal bindings. The built-in `core.utility.code` node is therefore
 * re-registered with a string schema for `code` (the executor stays the real
 * `CodeNode` + sandbox), so canonical documents can bind code literally.
 */
async function buildEngine(): Promise<{
  engine: GraphExecutionEngine;
  catalogue: GraphNodeCatalogue;
}> {
  const catalogue = freshCatalogue();
  const engine = await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    codeSandboxEvaluator: await bootCodeSandboxEvaluator(),
  });
  await registerBuiltInGraphNodes(catalogue);
  await catalogue.register(
    defineGraphNode({
      manifest: {
        ...CODE_GRAPH_NODE_MANIFEST,
        inputs: CODE_GRAPH_NODE_MANIFEST.inputs.map((port) =>
          port.id === "code" ? { ...port, schema: { type: "string" } } : port
        ),
      },
      executor: {
        execute: (request, context) => executeNode(CodeNode, request, context),
      },
    }),
    { replace: true }
  );
  return { engine, catalogue };
}

/**
 * Builds a `core.utility.code` node with its `code` supplied as a literal input
 * binding, leaving the optional `data` port open for edges.
 */
function codeNode(
  id: string,
  code: string,
  extra: Record<string, unknown> = {}
) {
  return documentNode(
    id,
    "core.utility.code",
    {},
    {
      ...extra,
      inputBindings: {
        code: { mode: "literal", value: code },
      },
    }
  );
}

/**
 * Builds a canonical switch node instance carrying the same case metadata on both
 * the instance `metadata` (so the manifest exposes the case output ports) and the
 * `parameters` (so the executor reads the routing configuration).
 */
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
    { cases: metadata.cases, hasDefault: true },
    { metadata: { switch: metadata } }
  );
}

const BIG_SMALL_CASES: SwitchNodeMetadata["cases"] = [
  {
    id: "big",
    label: "Big",
    outputPort: "big",
    condition: {
      op: "gte",
      left: { path: "value" },
      right: { const: 5 },
    },
  },
];

const HIGH_LOW_CASES: SwitchNodeMetadata["cases"] = [
  {
    id: "high",
    label: "High",
    outputPort: "high",
    condition: {
      op: "eq",
      left: { path: "value" },
      right: { const: "high" },
    },
  },
];

/**
 * Workflow 1: linear `code -> switch (condition) -> code`.
 */
function linearCodeConditionCodeDocument(): GraphWorkflowDocument {
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
      documentEdge(
        "e2",
        ["node", "start", "result"],
        ["node", "gate", "value"]
      ),
      documentEdge("e3", ["node", "gate", "big"], ["node", "big", "data"]),
      documentEdge(
        "e4",
        ["node", "gate", "default"],
        ["node", "small", "data"]
      ),
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

/**
 * Workflow 2: foreach loop over an array of numbers with a code body, followed
 * by a downstream collector code node.
 */
function foreachWorkflowDocument(): GraphWorkflowDocument {
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
      documentEdge(
        "f2",
        ["node", "loop", "completed"],
        ["node", "collect", "data"]
      ),
      documentEdge("f3", ["node", "collect", "result"], ["workflow", "result"]),
    ],
  };
}

/**
 * Workflow 3: a pinnable classifier code node feeding a switch with two branch
 * code nodes; the selected branch routes straight to the workflow output.
 */
function switchBranchPinningDocument(): GraphWorkflowDocument {
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
      documentEdge(
        "p2",
        ["node", "classify", "result"],
        ["node", "route", "value"]
      ),
      documentEdge(
        "p3",
        ["node", "route", "high"],
        ["node", "highBranch", "data"]
      ),
      documentEdge(
        "p4",
        ["node", "route", "default"],
        ["node", "lowBranch", "data"]
      ),
      documentEdge(
        "p5",
        ["node", "highBranch", "result"],
        ["workflow", "result"]
      ),
      documentEdge(
        "p6",
        ["node", "lowBranch", "result"],
        ["workflow", "result"]
      ),
    ],
  };
}

describe("as-graph integration — backend engine workflows (SAA-1930)", () => {
  it("runs a linear code -> switch condition -> code workflow and records per-node intermediate inputs/outputs", async () => {
    const { engine, catalogue } = await buildEngine();
    const document = linearCodeConditionCodeDocument();
    await resolveDocument(document, catalogue);

    const result = await engine.execute(document, { n: 7 });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe(80);

    expect(result.nodeResults.start.inputs).toEqual({
      code: START_CODE,
      data: 7,
    });
    expect(result.nodeResults.start.outputs).toEqual({ result: 8 });

    expect(result.nodeResults.gate.inputs).toEqual({ value: 8 });
    expect(result.nodeResults.gate.outputs).toEqual({ big: 8 });

    expect(result.nodeResults.big.inputs).toEqual({ code: BIG_CODE, data: 8 });
    expect(result.nodeResults.big.outputs).toEqual({ result: 80 });

    expect(result.nodeResults.small.status).toBe("skipped");
  });

  it("routes the linear workflow down the default branch when the condition does not match", async () => {
    const { engine, catalogue } = await buildEngine();
    const document = linearCodeConditionCodeDocument();
    await resolveDocument(document, catalogue);

    const result = await engine.execute(document, { n: 2 });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe(103);

    expect(result.nodeResults.start.outputs).toEqual({ result: 3 });
    expect(result.nodeResults.gate.inputs).toEqual({ value: 3 });
    expect(result.nodeResults.gate.outputs).toEqual({ default: 3 });
    expect(result.nodeResults.small.inputs).toEqual({
      code: SMALL_CODE,
      data: 3,
    });
    expect(result.nodeResults.small.outputs).toEqual({ result: 103 });
    expect(result.nodeResults.big.status).toBe("skipped");
  });

  it("runs a foreach workflow with a code body and asserts per-iteration and downstream intermediate values", async () => {
    const { engine, catalogue } = await buildEngine();
    const document = foreachWorkflowDocument();
    await resolveDocument(document, catalogue);

    const result = await engine.execute(document, { items: [1, 2, 3] });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe("2-4-6");

    expect(result.nodeResults.loop.inputs.items).toEqual([1, 2, 3]);
    expect(result.nodeResults.loop.outputs.completed).toEqual([2, 4, 6]);
    expect(result.nodeResults.loop.outputs.results).toEqual([2, 4, 6]);
    expect(result.nodeResults.loop.outputs.iterations).toBe(3);

    expect(result.nodeResults.collect.inputs).toEqual({
      code: COLLECT_CODE,
      data: [2, 4, 6],
    });
    expect(result.nodeResults.collect.outputs).toEqual({ result: "2-4-6" });
  });

  it("runs a switch-branch workflow and serves a pinned classifier node from the engine cache on re-run", async () => {
    const { engine, catalogue } = await buildEngine();
    const document = switchBranchPinningDocument();
    const resolved = await resolveDocument(document, catalogue);
    const plan = await new GraphExecutionPlanner().plan(resolved);

    const first = await engine.execute(document, { n: 42 });
    expect(first.status).toBe("succeeded");
    expect(first.outputs.result).toBe("HIGH:high");
    expect(first.nodeResults.classify.inputs).toEqual({
      code: CLASSIFY_CODE,
      data: 42,
    });
    expect(first.nodeResults.classify.outputs).toEqual({ result: "high" });
    expect(first.nodeResults.route.inputs).toEqual({ value: "high" });
    expect(first.nodeResults.route.outputs).toEqual({ high: "high" });
    expect(first.nodeResults.highBranch.inputs).toEqual({
      code: HIGH_CODE,
      data: "high",
    });
    expect(first.nodeResults.highBranch.outputs).toEqual({
      result: "HIGH:high",
    });
    expect(first.nodeResults.lowBranch.status).toBe("skipped");

    await engine.pinNode({
      document,
      plan,
      result: first,
      nodeId: "classify",
      includeDependencies: false,
    });

    const cached = await engine.execute(
      document,
      { n: 42 },
      {
        usePinnedValues: true,
      }
    );
    expect(cached.status).toBe("succeeded");
    expect(cached.outputs.result).toBe("HIGH:high");
    expect(cached.nodeResults.classify.fromCache).toBe(true);
    expect(cached.nodeResults.classify.pinned).toBe(true);
    expect(cached.nodeResults.classify.status).toBe("cached");
    expect(cached.nodeResults.highBranch.outputs).toEqual({
      result: "HIGH:high",
    });

    const changed = await engine.execute(
      document,
      { n: 3 },
      {
        usePinnedValues: true,
      }
    );
    expect(changed.status).toBe("succeeded");
    expect(changed.outputs.result).toBe("LOW:low");
    expect(changed.nodeResults.classify.fromCache).not.toBe(true);
    expect(changed.nodeResults.classify.outputs).toEqual({ result: "low" });
    expect(changed.nodeResults.lowBranch.inputs).toEqual({
      code: LOW_CODE,
      data: "low",
    });
    expect(changed.nodeResults.lowBranch.outputs).toEqual({
      result: "LOW:low",
    });
  });
});
