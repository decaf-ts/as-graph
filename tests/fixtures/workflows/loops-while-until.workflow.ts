/**
 * @module as-graph/tests/fixtures/workflows/loops-while-until
 * @summary Demo workflow: while loop feeding an until loop.
 * @description Covers `core.loop.while` and `core.loop.until`. Combos:
 * exposed ports (data edges), user-controlled properties (`inputPort`/
 * `outputPort`/`condition`) and defaults. Each loop body declares distinct
 * seed/result port ids (`in`/`out`) so the node output handle stays `state`.
 */
import { document, edge, node, port } from "./builders";
import type { GraphWorkflowFixture } from "./types";

const WHILE_INCREMENT_CODE = "return { n: $input.data.n + 1 };";
const UNTIL_INCREMENT_CODE = "return { n: $input.data.n + 1 };";

const whileBody = document({
  id: "fixture-loops-while-body",
  name: "fixture-loops-while-body",
  inputs: [port("in")],
  outputs: [port("out")],
  nodes: [
    node(
      "inc",
      "core.utility.code",
      {},
      { inputBindings: { code: { mode: "literal", value: WHILE_INCREMENT_CODE } } }
    ),
  ],
  edges: [
    edge("b1", ["workflow", "in"], ["node", "inc", "data"]),
    edge("b2", ["node", "inc", "result"], ["workflow", "out"]),
  ],
});

const untilBody = document({
  id: "fixture-loops-until-body",
  name: "fixture-loops-until-body",
  inputs: [port("in")],
  outputs: [port("out")],
  nodes: [
    node(
      "inc",
      "core.utility.code",
      {},
      { inputBindings: { code: { mode: "literal", value: UNTIL_INCREMENT_CODE } } }
    ),
  ],
  edges: [
    edge("b1", ["workflow", "in"], ["node", "inc", "data"]),
    edge("b2", ["node", "inc", "result"], ["workflow", "out"]),
  ],
});

export const loopsWhileUntilDocument = document({
  id: "fixture-loops-while-until",
  name: "fixture-loops-while-until",
  inputs: [port("state")],
  outputs: [port("result")],
  nodes: [
    node(
      "whileLoop",
      "core.loop.while",
      {
        maxIterations: 3,
        condition: { type: "lessThan", left: "n", right: 3 },
        inputPort: "in",
        outputPort: "out",
      },
      { loop: { body: whileBody } }
    ),
    node(
      "untilLoop",
      "core.loop.until",
      {
        maxIterations: 3,
        condition: { type: "greaterThanOrEqual", left: "n", right: 3 },
        inputPort: "in",
        outputPort: "out",
      },
      { loop: { body: untilBody } }
    ),
  ],
  edges: [
    edge("e1", ["workflow", "state"], ["node", "whileLoop", "state"]),
    edge("e2", ["node", "whileLoop", "state"], ["node", "untilLoop", "state"]),
    edge("e3", ["node", "untilLoop", "state"], ["workflow", "result"]),
  ],
});

export const loopsWhileUntilFixture: GraphWorkflowFixture = {
  id: loopsWhileUntilDocument.id,
  document: loopsWhileUntilDocument,
  kinds: ["core.loop.while", "core.loop.until", "core.utility.code"],
  combos: ["exposed-ports", "user-controlled-properties", "defaults"],
  executable: true,
  inputs: { state: { n: 0 } },
  expectedOutputs: { result: { n: 4 } },
};
