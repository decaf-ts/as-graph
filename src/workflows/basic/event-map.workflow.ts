/**
 * @module as-graph/workflows/basic/event-map
 * @summary Demo workflow: event trigger → map (transform) → result boundary.
 * @description Covers `core.trigger.event` and `core.utility.map`. Combos:
 * exposed ports (data edges) and defaults.
 */
import { document, edge, node, port } from "../builders";
import type { GraphWorkflowFixture } from "../types";

export const eventMapDocument = document({
  id: "fixture-event-map",
  name: "fixture-event-map",
  inputs: [],
  outputs: [port("mapped")],
  nodes: [
    node("trigger", "core.trigger.event"),
    node("transform", "core.utility.map", {
      expression: "({ ...$item, total: $item.qty * $item.price })",
    }),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["node", "trigger", "payload"], ["node", "transform", "value"]),
    edge("e2", ["node", "transform", "result"], ["node", "sink", "value"]),
    edge("e3", ["node", "transform", "result"], ["workflow", "mapped"]),
  ],
});

export const eventMapFixture: GraphWorkflowFixture = {
  id: eventMapDocument.id,
  document: eventMapDocument,
  kinds: ["core.trigger.event", "core.utility.map", "result"],
  combos: ["exposed-ports", "code-expression", "defaults"],
  executable: true,
  inputs: { payload: { sku: "bolt", qty: 4, price: 2.5 } },
  expectedOutputs: { mapped: { sku: "bolt", qty: 4, price: 2.5, total: 10 } },
};
