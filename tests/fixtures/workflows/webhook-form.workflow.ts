/**
 * @module as-graph/tests/fixtures/workflows/webhook-form
 * @summary Demo workflow: webhook + form triggers → delay/log side effects → result.
 * @description Covers `core.trigger.webhook`, `core.trigger.form`,
 * `core.flow.delay` and `core.flow.log`. Combos: exposed ports (literal
 * `schema` bindings + data edges), straight value and defaults.
 */
import { document, edge, node, port } from "./builders";
import type { GraphWorkflowFixture } from "./types";

export const webhookFormDocument = document({
  id: "fixture-webhook-form",
  name: "fixture-webhook-form",
  inputs: [],
  outputs: [port("delayed"), port("logged")],
  nodes: [
    node(
      "webhook",
      "core.trigger.webhook",
      {},
      { inputBindings: { schema: { mode: "literal", value: { type: "object" } } } }
    ),
    node(
      "form",
      "core.trigger.form",
      {},
      { inputBindings: { schema: { mode: "literal", value: { type: "object" } } } }
    ),
    node("delay", "core.flow.delay", { timeoutMs: 1 }),
    node("logger", "core.flow.log", { message: "form submission" }),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["node", "webhook", "payload"], ["node", "delay", "value"]),
    edge("e2", ["node", "form", "payload"], ["node", "logger", "value"]),
    edge("e3", ["node", "delay", "value"], ["node", "sink", "value"]),
    edge("e4", ["node", "delay", "value"], ["workflow", "delayed"]),
    edge("e5", ["node", "logger", "value"], ["workflow", "logged"]),
  ],
});

export const webhookFormFixture: GraphWorkflowFixture = {
  id: webhookFormDocument.id,
  document: webhookFormDocument,
  kinds: [
    "core.trigger.webhook",
    "core.trigger.form",
    "core.flow.delay",
    "core.flow.log",
    "result",
  ],
  combos: ["exposed-ports", "straight-value", "defaults"],
  executable: true,
  inputs: {},
  expectedOutputs: { delayed: { value: null }, logged: null },
};
