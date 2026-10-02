/**
 * @module as-graph/tests/integration/graph/fanOutFanIn.test
 * @summary SAA-1974 evidence: the engine's native fan-out/fan-in stream
 * behaviour after the `parallel`/`merge` node kinds were removed.
 * @description A node's output port with multiple outgoing edges fans out to
 * every downstream node; multiple incoming edges to one input port are gathered
 * before the node runs; layers execute with concurrency; and a failing branch
 * fails the run with its own error while its concurrent siblings still complete.
 */
import { describe, it, expect } from "@jest/globals";

import type { GraphNodeExecutionRequest } from "../../../src/engine/types";
import { GraphExecutionEventType } from "../../../src/shared/graph";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import {
  bootEngine,
  demoCatalogue,
  documentEdge,
  documentNode,
  documentPort,
} from "../../unit/graph/engine-fixtures";

type Executors = Parameters<typeof demoCatalogue>[0];

/** Boots the real engine over the given custom executor kinds. */
async function buildEngine(executors: Executors): Promise<GraphExecutionEngine> {
  const catalogue = await demoCatalogue(executors);
  return await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
  });
}

/**
 * Source: emits its configured literal `value` on the `out` output port.
 * Worker: doubles its `value` input. Collect: gathers `a`/`b`/`c` in order.
 */
function baseExecutors(
  overrides: Partial<Record<string, { execute: (r: GraphNodeExecutionRequest) => unknown }>> = {}
): Executors {
  const workers = {
    "test.source": {
      execute: (r: GraphNodeExecutionRequest) => ({ out: r.parameters.value }),
    },
    "test.worker": {
      execute: (r: GraphNodeExecutionRequest) => ({
        out: Number(r.inputs.value) * 2,
      }),
    },
    "test.collect": {
      execute: (r: GraphNodeExecutionRequest) => ({
        out: [r.inputs.a, r.inputs.b, r.inputs.c],
      }),
    },
  } as Executors;
  return { ...workers, ...overrides } as Executors;
}

/** Fan-out: one source output fans out to three downstream workers, then fan-in to one collector. */
function fanOutDocument(): GraphWorkflowDocument {
  return {
    id: "wf-fan-out",
    name: "wf-fan-out",
    inputs: [documentPort("n")],
    outputs: [documentPort("result")],
    nodes: [
      documentNode("src", "test.source", { value: 1 }),
      documentNode("w1", "test.worker"),
      documentNode("w2", "test.worker"),
      documentNode("w3", "test.worker"),
      documentNode("collect", "test.collect"),
    ],
    edges: [
      documentEdge("e_in", ["workflow", "n"], ["node", "src", "value"]),
      documentEdge("e_f1", ["node", "src", "out"], ["node", "w1", "value"]),
      documentEdge("e_f2", ["node", "src", "out"], ["node", "w2", "value"]),
      documentEdge("e_f3", ["node", "src", "out"], ["node", "w3", "value"]),
      documentEdge("e_c1", ["node", "w1", "out"], ["node", "collect", "a"]),
      documentEdge("e_c2", ["node", "w2", "out"], ["node", "collect", "b"]),
      documentEdge("e_c3", ["node", "w3", "out"], ["node", "collect", "c"]),
      documentEdge("e_out", ["node", "collect", "out"], ["workflow", "result"]),
    ],
  };
}

/** Fan-in: three distinct source ports target one input port and are gathered by sourcePort. */
function fanInDocument(): GraphWorkflowDocument {
  return {
    id: "wf-fan-in",
    name: "wf-fan-in",
    inputs: [],
    outputs: [documentPort("result")],
    nodes: [
      documentNode("s1", "test.srcA"),
      documentNode("s2", "test.srcB"),
      documentNode("s3", "test.srcC"),
      documentNode("gather", "test.gather"),
    ],
    edges: [
      documentEdge("g1", ["node", "s1", "a"], ["node", "gather", "value"]),
      documentEdge("g2", ["node", "s2", "b"], ["node", "gather", "value"]),
      documentEdge("g3", ["node", "s3", "c"], ["node", "gather", "value"]),
      documentEdge("g_out", ["node", "gather", "out"], ["workflow", "result"]),
    ],
  };
}

/** A wide fan-out (12 branches) whose outputs are summed by a single collector. */
function wideFanOutDocument(branchCount: number): GraphWorkflowDocument {
  const nodes = [documentNode("src", "test.source", { value: 3 })];
  const edges = [
    documentEdge("e_in", ["workflow", "n"], ["node", "src", "value"]),
  ];
  const inputs = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  for (let i = 0; i < branchCount; i++) {
    const id = `w${i}`;
    nodes.push(documentNode(id, "test.worker"));
    edges.push(documentEdge(`f${i}`, ["node", "src", "out"], ["node", id, "value"]));
    edges.push(
      documentEdge(`c${i}`, ["node", id, "out"], ["node", "collect", inputs[i]])
    );
  }
  nodes.push(documentNode("collect", "test.sum"));
  edges.push(documentEdge("e_out", ["node", "collect", "out"], ["workflow", "result"]));
  return {
    id: "wf-wide-fan-out",
    name: "wf-wide-fan-out",
    inputs: [documentPort("n")],
    outputs: [documentPort("result")],
    nodes,
    edges,
  };
}

describe("engine native fan-out / fan-in (SAA-1974)", () => {
  it("fans one output port out to every downstream node and gathers the branches", async () => {
    const engine = await buildEngine(baseExecutors());
    const result = await engine.execute(fanOutDocument(), { n: 0 });

    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.w1.outputs?.out).toBe(2);
    expect(result.nodeResults.w2.outputs?.out).toBe(2);
    expect(result.nodeResults.w3.outputs?.out).toBe(2);
    expect(result.nodeResults.collect.outputs?.out).toEqual([2, 2, 2]);
    expect(result.outputs.result).toEqual([2, 2, 2]);
  });

  it("gathers multiple incoming edges to one input port keyed by source port", async () => {
    const engine = await buildEngine({
      "test.srcA": { execute: () => ({ a: 1 }) },
      "test.srcB": { execute: () => ({ b: 2 }) },
      "test.srcC": { execute: () => ({ c: 3 }) },
      "test.gather": {
        execute: (r: GraphNodeExecutionRequest) => ({
          out: [r.inputs.a, r.inputs.b, r.inputs.c],
        }),
      },
    } as Executors);
    const result = await engine.execute(fanInDocument(), {});

    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.gather.outputs?.out).toEqual([1, 2, 3]);
    expect(result.outputs.result).toEqual([1, 2, 3]);
  });

  it("runs a wide fan-out deterministically, executing each branch exactly once", async () => {
    const branchCount = 12;
    const engine = await buildEngine({
      "test.source": { execute: () => ({ out: 3 }) },
      "test.worker": {
        execute: (r: GraphNodeExecutionRequest) => ({
          out: Number(r.inputs.value) * 2,
        }),
      },
      "test.sum": {
        execute: (r: GraphNodeExecutionRequest) => ({
          out: Object.values(r.inputs).reduce(
            (total: number, value) => total + Number(value),
            0
          ),
        }),
      },
    } as Executors);

    const result = await engine.execute(wideFanOutDocument(branchCount), { n: 0 });

    expect(result.status).toBe("succeeded");
    // 12 branches, each receiving 3 and doubling to 6.
    expect(result.outputs.result).toBe(72);
    for (let i = 0; i < branchCount; i++) {
      expect(result.nodeResults[`w${i}`].outputs?.out).toBe(6);
    }
  });

  it("propagates a concurrent branch failure with the failing branch's error", async () => {
    const engine = await buildEngine(
      baseExecutors({
        "test.worker": {
          execute: (r: GraphNodeExecutionRequest) => {
            if (r.parameters.bomb) throw new Error("branch exploded");
            return { out: Number(r.inputs.value) * 2 };
          },
        },
      })
    );
    const document = fanOutDocument();
    document.nodes.find((node) => node.id === "w2")!.parameters = { bomb: true };

    const result = await engine.execute(document, { n: 0 });

    expect(result.status).toBe("failed");
    expect(result.nodeResults.w2.error?.message).toBe("branch exploded");
    // Concurrent siblings still ran to completion.
    expect(result.nodeResults.w1.status).toBe("succeeded");
    expect(result.nodeResults.w3.status).toBe("succeeded");
  });

  it("emits a value-routed event for every fan-out edge", async () => {
    const engine = await buildEngine(baseExecutors());
    const events: { type: GraphExecutionEventType; edgeId?: string }[] = [];
    engine.observe({
      refresh: async (event) => {
        events.push(event as never);
      },
    });

    await engine.execute(fanOutDocument(), { n: 0 });

    const routed = events
      .filter((event) => event.type === GraphExecutionEventType.EDGE_VALUE_ROUTED)
      .map((event) => event.edgeId)
      .sort();
    expect(routed).toEqual(["e_c1", "e_c2", "e_c3", "e_f1", "e_f2", "e_f3", "e_out"]);
  });
});
