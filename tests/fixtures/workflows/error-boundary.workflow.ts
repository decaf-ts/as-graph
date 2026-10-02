/**
 * @module as-graph/tests/fixtures/workflows/error-boundary
 * @summary Demo workflow: error boundary guarding a failing code node.
 * @description Covers `core.flow.errorBoundary`, `core.utility.code` and the
 * `result` boundary. Combos: exposed ports (literal code + data edges) and
 * defaults. The failing `core.utility.code` body lives inside the boundary's
 * `errorBoundary.try` configuration; the boundary emits `error` on try failure,
 * so the workflow `caught` output carries the error and `result` stays undefined.
 */
import { document, edge, node, port } from "./builders";
import type { GraphWorkflowFixture } from "./types";

const BOOM_CODE = "throw new Error('boom');";

const errorBoundaryTryBody = document({
  id: "fixture-error-boundary-try",
  name: "fixture-error-boundary-try",
  inputs: [port("data")],
  outputs: [port("result")],
  nodes: [
    node(
      "boom",
      "core.utility.code",
      {},
      { inputBindings: { code: { mode: "literal", value: BOOM_CODE } } }
    ),
  ],
  edges: [
    edge("t1", ["workflow", "data"], ["node", "boom", "data"]),
    edge("t2", ["node", "boom", "result"], ["workflow", "result"]),
  ],
});

export const errorBoundaryDocument = document({
  id: "fixture-error-boundary",
  name: "fixture-error-boundary",
  inputs: [port("n")],
  outputs: [port("result"), port("caught")],
  nodes: [
    node(
      "guard",
      "core.flow.errorBoundary",
      {},
      { errorBoundary: { try: errorBoundaryTryBody } }
    ),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["workflow", "n"], ["node", "guard", "value"]),
    edge("e3", ["node", "guard", "result"], ["node", "sink", "value"]),
    edge("e4", ["node", "guard", "result"], ["workflow", "result"]),
    edge("e5", ["node", "guard", "error"], ["workflow", "caught"]),
  ],
});

export const errorBoundaryFixture: GraphWorkflowFixture = {
  id: errorBoundaryDocument.id,
  document: errorBoundaryDocument,
  kinds: ["core.flow.errorBoundary", "core.utility.code", "result"],
  combos: ["exposed-ports", "defaults"],
  executable: true,
  inputs: { n: "payload" },
  expectedOutputs: { result: undefined },
};
