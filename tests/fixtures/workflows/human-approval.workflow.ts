/**
 * @module as-graph/tests/fixtures/workflows/human-approval
 * @summary Demo workflow: human approval gate with approve/reject branches.
 * @description Covers `core.flow.humanApproval`, `core.flow.log` and the
 * `result` boundary. Combos: exposed ports (data edges) and user-controlled
 * properties (`parameters.message`, `parameters.approved`). The `approved` and
 * `rejected` outputs are mutually exclusive: the executor emits `approved` unless
 * the user-controlled boolean `approved` parameter is `false`, then `rejected`.
 */
import { document, edge, node, port } from "./builders";
import type { GraphWorkflowFixture } from "./types";

export const humanApprovalDocument = document({
  id: "fixture-human-approval",
  name: "fixture-human-approval",
  inputs: [port("n")],
  outputs: [port("approved"), port("rejected")],
  nodes: [
    node("approval", "core.flow.humanApproval", {
      message: "Approve the request?",
    }),
    node("logger", "core.flow.log", { message: "approval outcome" }),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["workflow", "n"], ["node", "approval", "value"]),
    edge("e2", ["node", "approval", "approved"], ["node", "logger", "value"]),
    edge("e3", ["node", "logger", "value"], ["node", "sink", "value"]),
    edge("e4", ["node", "logger", "value"], ["workflow", "approved"]),
    edge("e5", ["node", "approval", "rejected"], ["workflow", "rejected"]),
  ],
});

export const humanApprovalFixture: GraphWorkflowFixture = {
  id: humanApprovalDocument.id,
  document: humanApprovalDocument,
  kinds: ["core.flow.humanApproval", "core.flow.log", "result"],
  combos: ["exposed-ports", "user-controlled-properties", "defaults"],
  executable: true,
  inputs: { n: "ticket-42" },
  expectedOutputs: { approved: "ticket-42" },
};
