/**
 * @module as-graph/tests/fixtures/workflows/boundary-value
 * @summary Demo workflow: workflow input value boundary → output value boundary.
 * @description Covers the `value` (`GraphInputValueNode`) and `result`
 * (`GraphOutputValueNode`) boundary kinds. Combos: exposed ports (data edges)
 * and defaults.
 *
 * NOTE (SAA-2049 production gap): neither `value` nor `result` is part of
 * `GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND` / `GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND`
 * (only the 20 non-boundary kinds are registered). The integration harness
 * registers the two classes test-side so the fixtures can execute.
 */
import { document, edge, node, port } from "./builders";
import type { GraphWorkflowFixture } from "./types";

export const boundaryValueDocument = document({
  id: "fixture-boundary-value",
  name: "fixture-boundary-value",
  inputs: [],
  outputs: [port("out")],
  nodes: [node("seed", "value"), node("sink", "result")],
  edges: [
    edge("e1", ["node", "seed", "value"], ["node", "sink", "value"]),
    edge("e2", ["node", "seed", "value"], ["workflow", "out"]),
  ],
});

export const boundaryValueFixture: GraphWorkflowFixture = {
  id: boundaryValueDocument.id,
  document: boundaryValueDocument,
  kinds: ["value", "result"],
  combos: ["exposed-ports", "defaults"],
  executable: true,
  inputs: {},
  expectedOutputs: { out: null },
};
