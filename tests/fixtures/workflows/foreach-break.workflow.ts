/**
 * @module as-graph/tests/fixtures/workflows/foreach-break
 * @summary Demo workflow: foreach loop whose body doubles items then breaks.
 * @description Covers `core.loop.foreach`, `core.flow.break` and
 * `core.utility.code`. Combos: exposed ports (literal code + data edges),
 * user-controlled properties (`itemPort`/`resultPort`) and defaults.
 *
 * The `GraphBreakSignal` propagates out of the nested `execute` and out of the
 * failing node, so `core.flow.break` stops its enclosing `foreach`: the loop
 * terminates after the first iteration with `broken === true` and the partial
 * `collected: [2]`.
 */
import { document, edge, node, port } from "./builders";
import type { GraphWorkflowFixture } from "./types";

const DOUBLE_CODE = "return $item * 2;";

const foreachBody = document({
  id: "fixture-foreach-break-body",
  name: "fixture-foreach-break-body",
  inputs: [port("item")],
  outputs: [port("result")],
  nodes: [
    node(
      "double",
      "core.utility.code",
      {},
      { inputBindings: { code: { mode: "literal", value: DOUBLE_CODE } } }
    ),
    node("stop", "core.flow.break"),
  ],
  edges: [
    edge("b1", ["workflow", "item"], ["node", "double", "data"]),
    edge("b2", ["node", "double", "result"], ["workflow", "result"]),
    edge("b3", ["node", "double", "result"], ["node", "stop", "value"]),
  ],
});

export const foreachBreakDocument = document({
  id: "fixture-foreach-break",
  name: "fixture-foreach-break",
  inputs: [port("items")],
  outputs: [port("collected")],
  nodes: [
    node(
      "loop",
      "core.loop.foreach",
      { itemPort: "item", resultPort: "result", maxIterations: 10 },
      { loop: { body: foreachBody } }
    ),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["workflow", "items"], ["node", "loop", "items"]),
    edge("e2", ["node", "loop", "completed"], ["node", "sink", "value"]),
    edge("e3", ["node", "loop", "completed"], ["workflow", "collected"]),
  ],
});

export const foreachBreakFixture: GraphWorkflowFixture = {
  id: foreachBreakDocument.id,
  document: foreachBreakDocument,
  kinds: ["core.loop.foreach", "core.flow.break", "core.utility.code", "result"],
  combos: ["exposed-ports", "user-controlled-properties", "defaults"],
  executable: true,
  inputs: { items: [1, 2, 3] },
  expectedOutputs: { collected: [2] },
};
