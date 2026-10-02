/**
 * @module as-graph/tests/unit/graph/GraphTopology.test
 * @summary Unit tests for the graph topology helpers.
 */
import { GRAPH_WORKFLOW_BOUNDARY } from "../../../src/engine/constants";
import { GraphExecutionPlanner } from "../../../src/engine/planning/GraphExecutionPlanner";
import { GraphTopology } from "../../../src/engine/planning/GraphTopology";

import { handResolvedWorkflow, linearDocument } from "./engine-fixtures";

/**
 * Hand-built resolved workflow for the linear fixture document (topology
 * tests only traverse plan edge maps).
 */
function linearResolved() {
  return handResolvedWorkflow(
    linearDocument(),
    [
      { id: "adder", kind: "math.add", inputs: ["a", "b"], outputs: ["sum"] },
      { id: "multiplier", kind: "math.multiply", inputs: ["x"], outputs: ["product"] },
    ],
    [
      ["e1", "$workflow", "a", "adder", "a"],
      ["e2", "$workflow", "b", "adder", "b"],
      ["e3", "adder", "sum", "multiplier", "x"],
      ["e4", "multiplier", "product", "$workflow", "result"],
    ]
  );
}

describe("GraphTopology", () => {
  it("isBoundary identifies the workflow boundary id", () => {
    expect(GraphTopology.isBoundary(GRAPH_WORKFLOW_BOUNDARY)).toBe(true);
    expect(GraphTopology.isBoundary("n1")).toBe(false);
  });

  it("upstreamNodes returns dependencies excluding the boundary by default", async () => {
    const plan = await new GraphExecutionPlanner().plan(linearResolved());
    const upstream = GraphTopology.upstreamNodes("multiplier", plan.incomingByNode);
    expect(upstream.has("adder")).toBe(true);
    expect(upstream.has(GRAPH_WORKFLOW_BOUNDARY)).toBe(false);
  });

  it("upstreamNodes includes boundary when includeBoundary is true", async () => {
    const plan = await new GraphExecutionPlanner().plan(linearResolved());
    const upstream = GraphTopology.upstreamNodes("adder", plan.incomingByNode, true);
    expect(upstream.has(GRAPH_WORKFLOW_BOUNDARY)).toBe(true);
  });

  it("downstreamNodes returns dependents excluding the boundary by default", async () => {
    const plan = await new GraphExecutionPlanner().plan(linearResolved());
    const downstream = GraphTopology.downstreamNodes("adder", plan.outgoingByNode);
    expect(downstream.has("multiplier")).toBe(true);
    expect(downstream.has(GRAPH_WORKFLOW_BOUNDARY)).toBe(false);
  });

  it("downstreamNodes includes boundary when includeBoundary is true", async () => {
    const plan = await new GraphExecutionPlanner().plan(linearResolved());
    const downstream = GraphTopology.downstreamNodes("multiplier", plan.outgoingByNode, true);
    expect(downstream.has(GRAPH_WORKFLOW_BOUNDARY)).toBe(true);
  });
});
