/**
 * @module as-graph/tests/unit/graph/layout/GraphWorkflowLayout.test
 * @summary Headless unit tests for the pure left-to-right graph auto-layout
 * module (`computeGraphWorkflowLayout`, `toElkGraph`, `fromElkLayout`) shipped by
 * SAA-249.
 * @description Covers deterministic snapshots for canonical small documents
 * (linear chain, diamond, wide fan-out/fan-in, cycle and the loop-bearing
 * fixture), the node/edge result shape, node sizing, workflow-boundary edge
 * skipping, input non-mutation and run-to-run determinism. Every expectation is
 * derived from the module's documented contract; no `src/**` file is edited.
 */
import {
  computeGraphWorkflowLayout,
  fromElkLayout,
  GraphLayoutMode,
  GraphLayoutSpacing,
  toElkGraph,
  type GraphLayoutOptions,
  type GraphWorkflowLayoutResult,
} from "../../../../src/shared/graph";
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import { document, edge, node } from "../../../fixtures/workflows/builders";
import { loopsWhileUntilDocument } from "../../../fixtures/workflows/loops-while-until.workflow";

/** A→B→C→D linear chain. */
function linearChain(): GraphWorkflowDocument {
  return document({
    id: "layout-linear-chain",
    nodes: [
      node("a", "core.flow.log"),
      node("b", "core.flow.log"),
      node("c", "core.flow.log"),
      node("d", "core.flow.log"),
    ],
    edges: [
      edge("e1", ["node", "a", "out"], ["node", "b", "in"]),
      edge("e2", ["node", "b", "out"], ["node", "c", "in"]),
      edge("e3", ["node", "c", "out"], ["node", "d", "in"]),
    ],
  });
}

/** A→B, A→C, B→D, C→D diamond. */
function diamond(): GraphWorkflowDocument {
  return document({
    id: "layout-diamond",
    nodes: [
      node("a", "core.flow.if"),
      node("b", "core.flow.log"),
      node("c", "core.flow.log"),
      node("d", "core.flow.log"),
    ],
    edges: [
      edge("e1", ["node", "a", "true"], ["node", "b", "in"]),
      edge("e2", ["node", "a", "false"], ["node", "c", "in"]),
      edge("e3", ["node", "b", "out"], ["node", "d", "in"]),
      edge("e4", ["node", "c", "out"], ["node", "d", "in"]),
    ],
  });
}

/** One source fanning out to six sinks. */
function wideFanOut(): GraphWorkflowDocument {
  const sinks = ["s1", "s2", "s3", "s4", "s5", "s6"];
  return document({
    id: "layout-wide-fan-out",
    nodes: [node("src", "core.flow.log"), ...sinks.map((id) => node(id, "core.flow.log"))],
    edges: sinks.map((id, index) =>
      edge(`e${index + 1}`, ["node", "src", "out"], ["node", id, "in"])
    ),
  });
}

/** Six sources fanning into one sink. */
function wideFanIn(): GraphWorkflowDocument {
  const sources = ["s1", "s2", "s3", "s4", "s5", "s6"];
  return document({
    id: "layout-wide-fan-in",
    nodes: [...sources.map((id) => node(id, "core.flow.log")), node("dst", "core.flow.log")],
    edges: sources.map((id, index) =>
      edge(`e${index + 1}`, ["node", id, "out"], ["node", "dst", "in"])
    ),
  });
}

/** A→B→C→A cyclic graph (a reprising loop). */
function cyclic(): GraphWorkflowDocument {
  return document({
    id: "layout-cycle",
    nodes: [
      node("a", "core.loop.while"),
      node("b", "core.utility.code"),
      node("c", "core.loop.until"),
    ],
    edges: [
      edge("e1", ["node", "a", "state"], ["node", "b", "data"]),
      edge("e2", ["node", "b", "result"], ["node", "c", "state"]),
      edge("e3", ["node", "c", "state"], ["node", "a", "state"]),
    ],
  });
}

/** Asserts every node position is finite and keyed in document node order. */
function expectOrderedNodes(
  result: GraphWorkflowLayoutResult,
  source: GraphWorkflowDocument
): void {
  expect(Object.keys(result.nodes)).toEqual(source.nodes.map((entry) => entry.id));
  for (const id of Object.keys(result.nodes)) {
    expect(Number.isFinite(result.nodes[id].x)).toBe(true);
    expect(Number.isFinite(result.nodes[id].y)).toBe(true);
  }
}

describe("computeGraphWorkflowLayout snapshots (SAA-249)", () => {
  it("lays out a linear chain deterministically", async () => {
    const source = linearChain();
    const result = await computeGraphWorkflowLayout(source);
    expectOrderedNodes(result, source);
    expect(result).toMatchSnapshot();
  });

  it("lays out a diamond deterministically", async () => {
    const source = diamond();
    const result = await computeGraphWorkflowLayout(source);
    expectOrderedNodes(result, source);
    expect(result).toMatchSnapshot();
  });

  it("lays out a wide fan-out deterministically", async () => {
    const source = wideFanOut();
    const result = await computeGraphWorkflowLayout(source);
    expectOrderedNodes(result, source);
    expect(result).toMatchSnapshot();
  });

  it("lays out a wide fan-in deterministically", async () => {
    const source = wideFanIn();
    const result = await computeGraphWorkflowLayout(source);
    expectOrderedNodes(result, source);
    expect(result).toMatchSnapshot();
  });

  it("lays out a cycle-bearing document deterministically", async () => {
    const source = cyclic();
    const result = await computeGraphWorkflowLayout(source);
    expectOrderedNodes(result, source);
    expect(result).toMatchSnapshot();
  });

  it("lays out the loop-bearing workflow fixture deterministically", async () => {
    const result = await computeGraphWorkflowLayout(loopsWhileUntilDocument);
    expectOrderedNodes(result, loopsWhileUntilDocument);
    expect(result).toMatchSnapshot();
  });
});

describe("computeGraphWorkflowLayout result shape (SAA-249)", () => {
  it("keys nodes in document order and edges in document order", async () => {
    const source = linearChain();
    const result = await computeGraphWorkflowLayout(source);
    expect(Object.keys(result.nodes)).toEqual(["a", "b", "c", "d"]);
    expect(result.edges).toBeDefined();
    expect(Object.keys(result.edges ?? {})).toEqual(["e1", "e2", "e3"]);
  });

  it("omits the edges key when no node→node edge is routed", async () => {
    const source = document({
      id: "layout-boundary-only",
      inputs: [{ id: "in" }],
      outputs: [{ id: "out" }],
      nodes: [node("only", "core.flow.log")],
      edges: [
        edge("b1", ["workflow", "in"], ["node", "only", "in"]),
        edge("b2", ["node", "only", "out"], ["workflow", "out"]),
      ],
    });
    const result = await computeGraphWorkflowLayout(source);
    expect(Object.keys(result.nodes)).toEqual(["only"]);
    expect(result.edges).toBeUndefined();
  });

  it("is asynchronous and resolves a promise", () => {
    const pending = computeGraphWorkflowLayout(linearChain());
    expect(pending).toBeInstanceOf(Promise);
    return pending.then((result) => {
      expect(result.nodes.a).toBeDefined();
    });
  });
});

describe("computeGraphWorkflowLayout purity (SAA-249)", () => {
  it("does not mutate the input document", async () => {
    for (const source of [
      linearChain(),
      diamond(),
      wideFanOut(),
      wideFanIn(),
      cyclic(),
      loopsWhileUntilDocument,
    ]) {
      const before = structuredClone(source);
      await computeGraphWorkflowLayout(source, {
        mode: GraphLayoutMode.READABILITY,
        spacing: GraphLayoutSpacing.COMFORTABLE,
      });
      expect(source).toEqual(before);
    }
  });

  it("returns deep-equal results for the same document and options", async () => {
    const source = diamond();
    const options: GraphLayoutOptions = {
      mode: GraphLayoutMode.COMPACTNESS,
      spacing: GraphLayoutSpacing.TIGHT,
    };
    const first = await computeGraphWorkflowLayout(source, options);
    const second = await computeGraphWorkflowLayout(source, options);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("is deterministic for the default options", async () => {
    const source = linearChain();
    const first = await computeGraphWorkflowLayout(source);
    const second = await computeGraphWorkflowLayout(source);
    expect(second).toEqual(first);
  });
});

describe("toElkGraph adapter (SAA-249)", () => {
  it("forwards only node→node edges in document order", () => {
    const source = document({
      id: "layout-mixed-edges",
      inputs: [{ id: "in" }],
      outputs: [{ id: "out" }],
      nodes: [node("a", "core.flow.log"), node("b", "core.flow.log")],
      edges: [
        edge("b1", ["workflow", "in"], ["node", "a", "in"]),
        edge("e1", ["node", "a", "out"], ["node", "b", "in"]),
        edge("b2", ["node", "b", "out"], ["workflow", "out"]),
      ],
    });
    const graph = toElkGraph(source);
    expect(graph.id).toBe("layout-mixed-edges");
    expect(graph.edges?.map((entry) => entry.id)).toEqual(["e1"]);
    expect(graph.edges?.[0]).toMatchObject({
      sources: ["a"],
      targets: ["b"],
    });
  });

  it("skips node→node edges whose endpoints are missing from nodes", () => {
    const source = document({
      id: "layout-dangling",
      nodes: [node("a", "core.flow.log")],
      edges: [
        edge("e1", ["node", "a", "out"], ["node", "ghost", "in"]),
        edge("e2", ["node", "ghost", "out"], ["node", "a", "in"]),
      ],
    });
    expect(toElkGraph(source).edges).toEqual([]);
  });

  it("uses node.ui.size when present and the shared default otherwise", () => {
    const source = document({
      id: "layout-sizes",
      nodes: [
        node("sized", "core.flow.log", {}, {
          ui: { position: { x: 5, y: 6 }, size: { width: 240, height: 120 } },
        }),
        node("partial", "core.flow.log", {}, {
          ui: { position: { x: 0, y: 0 }, size: { width: 300 } },
        }),
        node("defaulted", "core.flow.log"),
      ],
    });
    const children = toElkGraph(source).children ?? [];
    expect(children.map((child) => ({ id: child.id, width: child.width, height: child.height }))).toEqual([
      { id: "sized", width: 240, height: 120 },
      { id: "partial", width: 300, height: 96 },
      { id: "defaulted", width: 96, height: 96 },
    ]);
  });

  it("keeps children in document node order", () => {
    const source = linearChain();
    expect(toElkGraph(source).children?.map((child) => child.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("fromElkLayout projection (SAA-249)", () => {
  const source = document({
    id: "layout-projection",
    nodes: [node("n1", "core.flow.log"), node("n2", "core.flow.log"), node("n3", "core.flow.log")],
    edges: [
      edge("e1", ["node", "n1", "out"], ["node", "n2", "in"]),
      edge("e2", ["node", "n2", "out"], ["node", "n3", "in"]),
    ],
  });

  it("maps laid-out children by id and defaults missing nodes to the origin", () => {
    const result = fromElkLayout(
      {
        id: "layout-projection",
        children: [
          { id: "n2", x: 110, y: 7 },
          { id: "n1", x: 0, y: 0 },
        ],
      } as never,
      source
    );
    expect(result.nodes).toEqual({
      n1: { x: 0, y: 0 },
      n2: { x: 110, y: 7 },
      n3: { x: 0, y: 0 },
    });
    expect(Object.keys(result.nodes)).toEqual(["n1", "n2", "n3"]);
    expect(result.edges).toBeUndefined();
  });

  it("projects edge waypoints in document edge order and drops unrouted edges", () => {
    const result = fromElkLayout(
      {
        id: "layout-projection",
        children: [
          { id: "n1", x: 0, y: 0 },
          { id: "n2", x: 110, y: 0 },
          { id: "n3", x: 220, y: 0 },
        ],
        edges: [
          {
            id: "e2",
            sources: ["n2"],
            targets: ["n3"],
            sections: [
              {
                startPoint: { x: 110, y: 48 },
                bendPoints: [{ x: 160, y: 48 }],
                endPoint: { x: 220, y: 48 },
              },
            ],
          },
          { id: "e1", sources: ["n1"], targets: ["n2"] },
        ],
      } as never,
      source
    );
    expect(Object.keys(result.edges ?? {})).toEqual(["e2"]);
    expect(result.edges?.e2).toEqual([
      { x: 110, y: 48 },
      { x: 160, y: 48 },
      { x: 220, y: 48 },
    ]);
  });
});
