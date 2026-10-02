/**
 * @module as-graph/tests/fixtures/workflows/chat-agent
 * @summary Demo workflow: chat trigger → agent (prompt/response/actions) → log → result.
 * @description Covers `core.trigger.chat`, `core.agent`, `core.flow.log` and the
 * `result` boundary. Combos: exposed ports (data edges) and defaults.
 */
import { document, edge, node, port } from "./builders";
import type { GraphWorkflowFixture } from "./types";

export const chatAgentDocument = document({
  id: "fixture-chat-agent",
  name: "fixture-chat-agent",
  inputs: [],
  outputs: [port("answer")],
  nodes: [
    node("chat", "core.trigger.chat"),
    node("agent", "core.agent"),
    node("logger", "core.flow.log"),
    node("sink", "result"),
  ],
  edges: [
    edge("e1", ["node", "chat", "message"], ["node", "agent", "prompt"]),
    edge("e2", ["node", "agent", "response"], ["node", "logger", "value"]),
    edge("e3", ["node", "agent", "actions"], ["node", "logger", "message"]),
    edge("e4", ["node", "logger", "value"], ["node", "sink", "value"]),
    edge("e5", ["node", "agent", "response"], ["workflow", "answer"]),
  ],
});

export const chatAgentFixture: GraphWorkflowFixture = {
  id: chatAgentDocument.id,
  document: chatAgentDocument,
  kinds: ["core.trigger.chat", "core.agent", "core.flow.log", "result"],
  combos: ["exposed-ports", "defaults"],
  executable: true,
  inputs: {},
  expectedOutputs: { answer: "[Agent response] " },
};
