/**
 * @module as-graph/tests/fixtures/workflows/manual-log
 * @summary Demo workflow: manual trigger → flow log + utility log → result boundary.
 * @description Covers `core.trigger.manual`, `core.flow.log`,
 * `core.utility.log` and the `result` boundary kind. Combos: straight value
 * (`parameters.message`), exposed ports (data edges), user-controlled
 * properties (`metadata.level` for the object-typed `level`) and defaults.
 */
import { document, edge, node, port } from "./builders";
import type { GraphWorkflowFixture } from "./types";

export const manualLogDocument = document({
  id: "fixture-manual-log",
  name: "fixture-manual-log",
  inputs: [],
  outputs: [port("logged"), port("audited")],
  nodes: [
    node("trigger", "core.trigger.manual"),
    node("logger", "core.flow.log", { message: "manual trigger run" }),
    node(
      "audit",
      "core.utility.log",
      {},
      { metadata: { message: "manual trigger audit", level: "info" } }
    ),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["node", "trigger", "payload"], ["node", "logger", "value"]),
    edge("e2", ["node", "logger", "value"], ["node", "sink", "value"]),
    edge("e3", ["node", "logger", "value"], ["workflow", "logged"]),
    edge("e4", ["node", "trigger", "payload"], ["node", "audit", "value"]),
    edge("e5", ["node", "audit", "value"], ["workflow", "audited"]),
  ],
});

export const manualLogFixture: GraphWorkflowFixture = {
  id: manualLogDocument.id,
  document: manualLogDocument,
  kinds: [
    "core.trigger.manual",
    "core.flow.log",
    "core.utility.log",
    "result",
  ],
  combos: [
    "straight-value",
    "exposed-ports",
    "user-controlled-properties",
    "defaults",
  ],
  executable: true,
  inputs: {},
  expectedOutputs: { logged: null, audited: null },
};
