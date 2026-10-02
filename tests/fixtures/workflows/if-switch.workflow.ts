/**
 * @module as-graph/tests/fixtures/workflows/if-switch
 * @summary Demo workflow: if branch → code → switch routing → result boundaries.
 * @description Covers `core.flow.if`, `core.flow.switch`, `core.utility.code`
 * and the `result` boundary. Combos: user-controlled properties (`else`,
 * `cases`, `hasDefault`), exposed ports (literal code + expression `data`
 * binding + data edges) and defaults.
 */
import type { SwitchNodeMetadata } from "../../../src/node/flow/switch/node";
import { document, edge, node, port } from "./builders";
import type { GraphWorkflowFixture } from "./types";

const BIG_CODE = "return $input.data * 10;";

const CASES: SwitchNodeMetadata["cases"] = [
  {
    id: "high",
    label: "High",
    outputPort: "high",
    condition: { op: "gte", left: { path: "value" }, right: { const: 50 } },
  },
];

export const ifSwitchDocument = document({
  id: "fixture-if-switch",
  name: "fixture-if-switch",
  inputs: [port("n")],
  outputs: [port("result")],
  nodes: [
    node(
      "branch",
      "core.flow.if",
      { else: true },
      {
        metadata: {
          condition: { op: "gte", left: { path: "value" }, right: { const: 5 } },
        },
      }
    ),
    node(
      "big",
      "core.utility.code",
      {},
      {
        inputBindings: {
          code: { mode: "literal", value: BIG_CODE },
          data: { mode: "expression", expression: "$input.data" },
        },
      }
    ),
    node(
      "route",
      "core.flow.switch",
      { cases: CASES, hasDefault: true },
      {
        metadata: {
          switch: { cases: CASES, defaultPort: "default", hasDefault: true },
        },
      }
    ),
    node("high", "result"),
    node("fallback", "result"),
    node("low", "result"),
  ],
  edges: [
    edge("e1", ["workflow", "n"], ["node", "branch", "value"]),
    edge("e2", ["node", "branch", "then"], ["node", "big", "data"]),
    edge("e3", ["node", "big", "result"], ["node", "route", "value"]),
    edge("e4", ["node", "route", "high"], ["node", "high", "value"]),
    edge("e5", ["node", "route", "default"], ["node", "fallback", "value"]),
    edge("e6", ["node", "branch", "else"], ["node", "low", "value"]),
    edge("e7", ["node", "route", "high"], ["workflow", "result"]),
    edge("e8", ["node", "route", "default"], ["workflow", "result"]),
    edge("e9", ["node", "branch", "else"], ["workflow", "result"]),
  ],
});

export const ifSwitchFixture: GraphWorkflowFixture = {
  id: ifSwitchDocument.id,
  document: ifSwitchDocument,
  kinds: ["core.flow.if", "core.flow.switch", "core.utility.code", "result"],
  combos: ["user-controlled-properties", "code-expression", "exposed-ports", "defaults"],
  executable: true,
  inputs: { n: 7 },
  expectedOutputs: { result: 70 },
};
