/**
 * @module as-graph/workflows/mastra/chat-agent
 * @summary Demo workflow: chat trigger → agent (prompt/response/actions) → log → result.
 * @description Covers `core.trigger.chat`, `core.agent`, `core.flow.log` and the
 * `result` boundary. Mastra set (contains `core.agent`). Combos: exposed ports
 * (data edges) and defaults.
 */
import { document, edge, node, port } from "../builders";
import type { GraphWorkflowFixture } from "../types";

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
  targetKinds: ["core.agent", "core.trigger.chat"],
  combos: ["exposed-ports", "defaults"],
  family: "mastra",
  engine: "mastra",
  capabilities: ["agentLlmNode", "agentToolBuilders", "declarativeDocument"],
  requiredHostServices: ["agent", "createAgent"],
  executable: true,
  inputs: { message: "hello from the mastra fixture" },
  expectations: {
    mastra: {
      executable: true,
      expectedStatus: "succeeded",
      expectedSucceededNodeIds: ["chat", "agent", "logger", "sink"],
    },
    local: {
      executable: false,
      skipReason:
        "core.agent is mastra-only (SAA-837 M1); the local/general engine fails closed with GRAPH_LOCAL_UNSUPPORTED_NODE_KIND.",
    },
  },
};
