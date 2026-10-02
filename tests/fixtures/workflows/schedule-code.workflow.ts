/**
 * @module as-graph/tests/fixtures/workflows/schedule-code
 * @summary Demo workflow: schedule trigger → code (transform) → result boundary.
 * @description Covers `core.trigger.schedule` and `core.utility.code`. Combos:
 * user-controlled properties (`parameters.cron`, `parameters.timeoutMs`),
 * exposed ports (`inputBindings.code` literal) and defaults (omitted
 * `language`).
 */
import { document, edge, node, port } from "./builders";
import type { GraphWorkflowFixture } from "./types";

const SCHEDULE_CODE = "return ($input.data ?? 0) + 1;";

export const scheduleCodeDocument = document({
  id: "fixture-schedule-code",
  name: "fixture-schedule-code",
  inputs: [],
  outputs: [port("computed")],
  nodes: [
    node("schedule", "core.trigger.schedule", {
      cron: { expression: "0 * * * *" },
    }),
    node(
      "compute",
      "core.utility.code",
      { timeoutMs: 1000 },
      { inputBindings: { code: { mode: "literal", value: SCHEDULE_CODE } } }
    ),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["node", "schedule", "payload"], ["node", "compute", "data"]),
    edge("e2", ["node", "compute", "result"], ["node", "sink", "value"]),
    edge("e3", ["node", "compute", "result"], ["workflow", "computed"]),
  ],
});

export const scheduleCodeFixture: GraphWorkflowFixture = {
  id: scheduleCodeDocument.id,
  document: scheduleCodeDocument,
  kinds: ["core.trigger.schedule", "core.utility.code", "result"],
  combos: ["user-controlled-properties", "exposed-ports", "defaults"],
  executable: true,
  inputs: {},
  expectedOutputs: { computed: 1 },
};
