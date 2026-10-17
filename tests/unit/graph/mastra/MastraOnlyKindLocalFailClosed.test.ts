/**
 * @module as-graph/tests/unit/graph/mastra/MastraOnlyKindLocalFailClosed
 * @summary SAA-837 M1 capability-boundary tests: the mastra AI family
 * (`core.agent` and every `core.agent.*` kind) fails closed on the general
 * (local) engine instead of executing a placeholder.
 * @description Pins `graphNodeRequiresMastraEngine`'s classification (only the
 * `core.agent` family is mastra-only) and drives a real
 * {@link LocalGraphExecutionBackend} run to prove a `core.agent` and a
 * `core.agent.*` node fail closed with
 * {@link GRAPH_LOCAL_UNSUPPORTED_NODE_KIND} before their executor is invoked.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { GraphExecutionStatus } from "../../../../src/shared/graph/constants";
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import { GraphNodeExecutorRegistry } from "../../../../src/engine/registry/GraphNodeExecutorRegistry";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";
import { graphNodeRequiresMastraEngine } from "../../../../src/engine/execution/GraphNodeEngineRequirements";
import { GRAPH_LOCAL_UNSUPPORTED_NODE_KIND } from "../../../../src/engine/constants";
import {
  bootEngine,
  demoCatalogue,
  documentEdge,
  documentNode,
  documentPort,
} from "../engine-fixtures";

/** Every mastra AI-family leaf kind (the `core.agent.*` sub-kinds). */
const AGENT_FAMILY_KINDS = [
  "core.agent.tool",
  "core.agent.toolSelector",
  "core.agent.hook",
  "core.agent.toolDeny",
  "core.agent.delegationHook",
  "core.agent.skill",
  "core.agent.skillSelector",
  "core.agent.sandbox",
  "core.agent.scorer",
  "core.agent.scorerSelector",
] as const;

/** Kind-prefix neighbours that must NOT be classified as mastra-only. */
const NON_AGENT_KINDS = [
  "core.agents",
  "core.agentless",
  "value",
  "core.flow.if",
  "core.flow.delay",
  "core.loop.foreach",
  "core.utility.log",
  "core.utility.code",
  "core.trigger.chat",
] as const;

/** A single-node canonical document of the given kind. */
function singleNodeDocument(kind: string): GraphWorkflowDocument {
  return {
    id: `local-fail-closed-${kind.replace(/\./g, "-")}`,
    name: `local-fail-closed-${kind}`,
    inputs: [documentPort("prompt")],
    outputs: [documentPort("answer")],
    nodes: [documentNode("agent", kind)],
    edges: [
      documentEdge("e1", ["workflow", "prompt"], ["node", "agent", "prompt"]),
      documentEdge("e2", ["node", "agent", "response"], ["workflow", "answer"]),
    ],
  };
}

/**
 * Boots the local engine over a lenient catalogue that registers the given
 * kinds with a recording executor, so a failing node can only be failing on the
 * engine's fail-closed check — never on a missing executor.
 */
async function bootLocalEngine(kinds: readonly string[]) {
  const calls: string[] = [];
  const executors = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      {
        execute: () => {
          calls.push(kind);
          return {};
        },
      },
    ])
  );
  const registry = new GraphNodeExecutorRegistry(
    await demoCatalogue(executors)
  );
  const engine = await bootEngine({ registry });
  return { engine, calls };
}

describe("graphNodeRequiresMastraEngine — capability boundary (SAA-837 M1)", () => {
  it("classifies core.agent and every core.agent.* kind as mastra-only", () => {
    expect(graphNodeRequiresMastraEngine("core.agent")).toBe(true);
    for (const kind of AGENT_FAMILY_KINDS) {
      expect({ kind, required: graphNodeRequiresMastraEngine(kind) }).toEqual({
        kind,
        required: true,
      });
    }
  });

  it("leaves every general-engine kind outside the mastra-only family", () => {
    for (const kind of NON_AGENT_KINDS) {
      expect({ kind, required: graphNodeRequiresMastraEngine(kind) }).toEqual({
        kind,
        required: false,
      });
    }
  });
});

describe("local engine fails closed on the mastra AI family (SAA-837 M1)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it.each(["core.agent", "core.agent.tool"])(
    "fails a %s node closed with GRAPH_LOCAL_UNSUPPORTED_NODE_KIND without running its executor",
    async (kind) => {
      const { engine, calls } = await bootLocalEngine([kind]);

      const result = await engine.execute(singleNodeDocument(kind), {});

      expect(result.status).toBe(GraphExecutionStatus.FAILED);
      expect(result.nodeResults["agent"]?.error?.code).toBe(
        GRAPH_LOCAL_UNSUPPORTED_NODE_KIND
      );
      // The registered executor was never invoked: the boundary check runs
      // before delegation.
      expect(calls).toEqual([]);
    }
  );

  // SAA-836 M5: the new mastra-only kinds fail closed on the general engine
  // through the same `core.agent*` prefix rule — no new engine wiring needed.
  // SAA-836 M6: the channel trigger/response and voice kinds join them.
  it.each([
    "core.agent.inputProcessor",
    "core.agent.outputProcessor",
    "core.agent.guardrail",
    "core.agent.hitl",
    "core.agent.trigger.mcp",
    "core.agent.trigger.slack",
    "core.agent.trigger.discord",
    "core.agent.trigger.telegram",
    "core.agent.trigger.teams",
    "core.agent.response.slack",
    "core.agent.response.discord",
    "core.agent.response.telegram",
    "core.agent.response.teams",
    "core.agent.voice",
  ])(
    "fails a %s node closed with GRAPH_LOCAL_UNSUPPORTED_NODE_KIND without running its executor",
    async (kind) => {
      const { engine, calls } = await bootLocalEngine([kind]);

      const result = await engine.execute(singleNodeDocument(kind), {});

      expect(result.status).toBe(GraphExecutionStatus.FAILED);
      expect(result.nodeResults["agent"]?.error?.code).toBe(
        GRAPH_LOCAL_UNSUPPORTED_NODE_KIND
      );
      expect(calls).toEqual([]);
    }
  );
});
