/**
 * @module as-graph/tests/integration/graph/loopBodyLayout.test
 * @summary A loop body drawn on the canvas validates, runs and round-trips.
 * @description The editor draws a loop body as nodes chained from the loop's
 * body-entry port back into its `loop` port, on the same canvas as the loop.
 * The canonical format nests the body as a document. These cases use the
 * document shape the editor actually sends and prove the engine accepts it,
 * that the loop kinds publish the ports it uses, and that nesting and
 * flattening are inverse.
 */
import { describe, it, expect } from "@jest/globals";
import {
  GRAPH_LOOP_PARENT_METADATA_KEY,
  graphFlattenLoopBodies,
  graphNestLoopBodies,
  type GraphWorkflowDocument,
} from "../../../src/shared/graph";
import { GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND } from "../../../src/node";
import { document, edge, node, port } from "../../../src/workflows/builders";
import { orderAnalyticsDocument } from "../../../src/workflows/basic/order-analytics.workflow";
import { bootFixtureEngine } from "../../fixtures/workflow-engine";

/** The canvas form: a foreach whose body is two chained nodes plus a ghost. */
function canvasForeach(): GraphWorkflowDocument {
  return document({
    id: "canvas-foreach",
    inputs: [port("items")],
    outputs: [port("collected")],
    nodes: [
      node("loop", "core.loop.foreach", {}),
      node("tag", "core.data.set", {
        includeOtherFields: true,
        assignments: [{ name: "seen", type: "boolean", value: true }],
      }),
      node("wait", "core.flow.delay", { timeoutMs: 1 }),
      node("ghost-loop", "core.flow.log", {}, { metadata: { ghost: true } }),
    ],
    edges: [
      edge("e1", ["workflow", "items"], ["node", "loop", "items"]),
      edge("e2", ["node", "loop", "completed"], ["workflow", "collected"]),
      edge("b1", ["node", "loop", "item"], ["node", "tag", "value"]),
      edge("b2", ["node", "tag", "result"], ["node", "wait", "value"]),
      edge("b3", ["node", "wait", "value"], ["node", "loop", "loop"], "connection"),
      edge("g1", ["node", "loop", "item"], ["node", "ghost-loop", "value"]),
    ],
  });
}

describe("loop kinds publish their body ports", () => {
  it.each([
    ["core.loop.foreach", "item"],
    ["core.loop.while", "body"],
    ["core.loop.until", "body"],
  ])("%s declares the '%s' body-entry output and the 'loop' exit", (kind, entry) => {
    const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[kind];
    const entryPort = manifest.outputs.find((candidate) => candidate.id === entry);
    expect(entryPort?.metadata).toEqual({ loopBody: "entry" });
    const exit = (manifest.connections ?? []).find(
      (candidate) => candidate.id === "loop"
    );
    expect(exit?.metadata).toEqual({ loopBody: "exit" });
    expect(exit?.connectionPolicy).toMatchObject({ allowSelf: true });
  });
});

describe("graphNestLoopBodies", () => {
  it("moves a canvas chain into loop.body and drops the ghost", () => {
    const { document: nested, changed, issues } = graphNestLoopBodies(
      canvasForeach()
    );
    expect(changed).toBe(true);
    expect(issues).toEqual([]);
    expect(nested.nodes.map((entry) => entry.id)).toEqual(["loop"]);
    expect(nested.edges.map((entry) => entry.id)).toEqual(["e1", "e2"]);
    const body = nested.nodes[0].loop!.body;
    expect(body.inputs).toEqual([{ id: "item" }]);
    expect(body.outputs).toEqual([{ id: "result" }]);
    expect(body.nodes.map((entry) => entry.id)).toEqual(["tag", "wait"]);
    expect(
      body.edges.map((entry) => [entry.id, entry.source, entry.target])
    ).toEqual([
      ["b1", { scope: "workflow", port: "item" }, { scope: "node", nodeId: "tag", port: "value" }],
      ["b2", { scope: "node", nodeId: "tag", port: "result" }, { scope: "node", nodeId: "wait", port: "value" }],
      ["b3", { scope: "node", nodeId: "wait", port: "value" }, { scope: "workflow", port: "result" }],
    ]);
  });

  it("leaves a canonical document untouched", () => {
    const result = graphNestLoopBodies(orderAnalyticsDocument);
    expect(result.changed).toBe(false);
    expect(result.document).toBe(orderAnalyticsDocument);
  });

  it("reports a body node that feeds a node outside the loop", () => {
    const doc = canvasForeach();
    doc.outputs.push({ id: "leak" });
    doc.edges.push(edge("leak", ["node", "tag", "result"], ["workflow", "leak"]));
    const { issues } = graphNestLoopBodies(doc);
    expect(issues).toEqual([
      expect.objectContaining({ code: "loop.body-escapes", loopId: "loop", subject: "leak" }),
    ]);
  });

  it("nests a loop drawn inside another loop's body", () => {
    const doc = document({
      id: "canvas-nested",
      inputs: [port("groups")],
      outputs: [port("out")],
      nodes: [
        node("outer", "core.loop.foreach", {}),
        node("inner", "core.loop.foreach", {}),
        node("tag", "core.data.set", { includeOtherFields: true, assignments: [] }),
      ],
      edges: [
        edge("e1", ["workflow", "groups"], ["node", "outer", "items"]),
        edge("o1", ["node", "outer", "item"], ["node", "inner", "items"]),
        edge("i1", ["node", "inner", "item"], ["node", "tag", "value"]),
        edge("i2", ["node", "tag", "result"], ["node", "inner", "loop"], "connection"),
        edge("o2", ["node", "inner", "completed"], ["node", "outer", "loop"], "connection"),
        edge("e2", ["node", "outer", "completed"], ["workflow", "out"]),
      ],
    });
    const { document: nested, issues } = graphNestLoopBodies(doc);
    expect(issues).toEqual([]);
    expect(nested.nodes.map((entry) => entry.id)).toEqual(["outer"]);
    const outerBody = nested.nodes[0].loop!.body;
    expect(outerBody.nodes.map((entry) => entry.id)).toEqual(["inner"]);
    expect(outerBody.nodes[0].loop!.body.nodes.map((entry) => entry.id)).toEqual(["tag"]);
  });
});

describe("graphFlattenLoopBodies", () => {
  it("draws a nested body on the canvas and nests back to the same document", () => {
    const flat = graphFlattenLoopBodies(orderAnalyticsDocument);
    const members = flat.nodes.filter(
      (entry) => entry.metadata?.[GRAPH_LOOP_PARENT_METADATA_KEY] === "segmented"
    );
    expect(members.map((entry) => entry.id)).toEqual(["isKey", "key", "standard"]);
    expect(
      flat.edges.some(
        (entry) =>
          entry.source.scope === "node" &&
          entry.source.nodeId === "segmented" &&
          entry.source.port === "item"
      )
    ).toBe(true);

    const back = graphNestLoopBodies(flat).document;
    const original = orderAnalyticsDocument.nodes.find(
      (entry) => entry.id === "segmented"
    )!.loop!.body;
    const restored = back.nodes.find((entry) => entry.id === "segmented")!.loop!.body;
    expect(restored.nodes).toEqual(original.nodes);
    expect(restored.edges.map((entry) => [entry.source, entry.target])).toEqual(
      original.edges.map((entry) => [entry.source, entry.target])
    );
    expect(back.nodes.map((entry) => entry.id)).toEqual(
      orderAnalyticsDocument.nodes.map((entry) => entry.id)
    );
  });
});

describe("engine accepts the canvas form", () => {
  it("validates and runs a foreach whose body is drawn on the canvas", async () => {
    const { engine } = await bootFixtureEngine();
    const result = await engine.execute(canvasForeach(), {
      items: [{ id: 1 }, { id: 2 }],
    });
    expect(result.status).toBe("succeeded");
    expect(result.outputs.collected).toEqual([
      { id: 1, seen: true },
      { id: 2, seen: true },
    ]);
  });

  it("runs a while loop whose body is drawn on the canvas", async () => {
    const { engine } = await bootFixtureEngine();
    const doc = document({
      id: "canvas-while",
      inputs: [port("start")],
      outputs: [port("end"), port("iterations")],
      nodes: [
        node("loop", "core.loop.while", {
          maxIterations: 10,
          condition: { op: "lt", left: { path: "n" }, right: { const: 3 } },
        }),
        node(
          "inc",
          "core.utility.code",
          {},
          { inputBindings: { code: { mode: "literal", value: "return { n: $input.data.n + 1 };" } } }
        ),
      ],
      edges: [
        edge("e1", ["workflow", "start"], ["node", "loop", "state"]),
        edge("b1", ["node", "loop", "body"], ["node", "inc", "data"]),
        edge("b2", ["node", "inc", "result"], ["node", "loop", "loop"], "connection"),
        edge("e2", ["node", "loop", "state"], ["workflow", "end"]),
        edge("e3", ["node", "loop", "iterations"], ["workflow", "iterations"]),
      ],
    });
    const result = await engine
      .execute(doc, { start: { n: 0 } })
      .catch((error: { issues?: unknown }) => {
        throw new Error(JSON.stringify(error.issues));
      });
    expect(result.status).toBe("succeeded");
    expect(result.outputs.end).toEqual({ n: 3 });
    expect(result.outputs.iterations).toBe(3);
  });
});
