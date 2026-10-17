/**
 * @module as-graph/tests/unit/graph/mastra/MastraAgentFamilyNodes
 * @summary Unit tests for the ten SAA-836 M3 mastra AI-family node kinds
 * (`core.agent.tool`/`toolSelector`/`hook`/`toolDeny`/`delegationHook`/
 * `skill`/`skillSelector`/`sandbox`/`scorer`/`scorerSelector`).
 * @description Pins the manifest surface (kind, Agent category, zone connection
 * ports) and the instance `execute` contract of every family node, including the
 * dynamic selector decision logic, the tool-deny verdict, the hook/delegation
 * context routing, and the sandbox `timeoutMs` ceiling guard
 * (`clampSandboxTimeoutMs`, reusing the `GRAPH_CODE_SANDBOX_TIMEOUT` path).
 */
import { describe, it, expect, afterAll } from "@jest/globals";
import { graphNodeManifest } from "../../../../src/shared/graph";
import {
  AgentToolNode,
  AgentToolSelectorNode,
  AgentHookNode,
  AgentToolDenyNode,
  AgentDelegationHookNode,
  AgentSkillNode,
  AgentSkillSelectorNode,
  AgentSandboxNode,
  AgentScorerNode,
  AgentScorerSelectorNode,
  GRAPH_AGENT_FAMILY_NODES,
  clampSandboxTimeoutMs,
} from "../../../../src/node";
import { MASTRA_AGENT_ZONE, MASTRA_AGENT_ZONES } from "../../../../src/node";
import type { GraphNodeClass } from "../../../../src/node/base";
import { GRAPH_CODE_MAX_TIMEOUT_MS } from "../../../../src/engine/constants";
import { GRAPH_CODE_DEFAULT_TIMEOUT_MS } from "../../../../src/node/utility/code/node";
import { GraphEnvironment } from "../../../../src/engine/services/GraphEnvironment";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "../nodes/node-test-utils";

/** One row of the family manifest conformance table. */
interface FamilyCase {
  name: string;
  node: GraphNodeClass;
  kind: string;
  inputs: string[];
  outputs: string[];
  /** `[portId, zoneCategory]`, or `undefined` for a zone-less kind (tool deny). */
  connection?: [string, string];
}

const CASES: FamilyCase[] = [
  {
    name: "tool",
    node: AgentToolNode,
    kind: "core.agent.tool",
    inputs: ["toolId", "description"],
    outputs: ["resource"],
    connection: ["tool", MASTRA_AGENT_ZONE.tools],
  },
  {
    name: "toolSelector",
    node: AgentToolSelectorNode,
    kind: "core.agent.toolSelector",
    inputs: ["decision", "tools"],
    outputs: ["selected", "resource"],
    connection: ["tool", MASTRA_AGENT_ZONE.tools],
  },
  {
    name: "hook",
    node: AgentHookNode,
    kind: "core.agent.hook",
    inputs: ["phase", "toolName", "value"],
    outputs: ["toolName", "input", "output", "error", "value"],
    connection: ["hook", MASTRA_AGENT_ZONE.hooks],
  },
  {
    name: "toolDeny",
    node: AgentToolDenyNode,
    kind: "core.agent.toolDeny",
    inputs: ["replacement", "reason", "value"],
    outputs: ["proceed", "value", "denied", "reason"],
  },
  {
    name: "delegationHook",
    node: AgentDelegationHookNode,
    kind: "core.agent.delegationHook",
    inputs: ["phase", "subAgentId", "value"],
    outputs: ["fromAgentId", "toAgentId", "input", "output", "error", "value"],
    connection: ["hook", MASTRA_AGENT_ZONE.hooks],
  },
  {
    name: "skill",
    node: AgentSkillNode,
    kind: "core.agent.skill",
    inputs: ["name", "description", "instructions"],
    outputs: ["resource"],
    connection: ["skill", MASTRA_AGENT_ZONE.skill],
  },
  {
    name: "skillSelector",
    node: AgentSkillSelectorNode,
    kind: "core.agent.skillSelector",
    inputs: ["decision", "skills"],
    outputs: ["selected", "resource"],
    connection: ["skill", MASTRA_AGENT_ZONE.skill],
  },
  {
    name: "sandbox",
    node: AgentSandboxNode,
    kind: "core.agent.sandbox",
    inputs: ["workingDirectory", "isolation", "timeoutMs"],
    outputs: ["resource"],
    connection: ["sandbox", MASTRA_AGENT_ZONE.sandbox],
  },
  {
    name: "scorer",
    node: AgentScorerNode,
    kind: "core.agent.scorer",
    inputs: ["scorerId", "description", "scorerType"],
    outputs: ["resource"],
    connection: ["scorer", MASTRA_AGENT_ZONE.scorers],
  },
  {
    name: "scorerSelector",
    node: AgentScorerSelectorNode,
    kind: "core.agent.scorerSelector",
    inputs: ["decision", "scorers"],
    outputs: ["selected", "resource"],
    connection: ["scorer", MASTRA_AGENT_ZONE.scorers],
  },
];

describe("Mastra AI-family nodes — manifest surface (SAA-836 M3)", () => {
  it("exposes exactly the ten family kinds plus their registered constructors", () => {
    expect(CASES.map((entry) => entry.kind)).toEqual([
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
    ]);
    expect(GRAPH_AGENT_FAMILY_NODES).toHaveLength(10);
  });

  it("declares the canonical agent connection zones", () => {
    // SAA-836 M5: the agent surface also exposes the processor pipelines
    // (`inputProcessors`, `outputProcessors`; guardrails connect on the
    // `outputProcessors` zone and compose with the post-processor pipeline).
    expect(MASTRA_AGENT_ZONES).toEqual([
      "memory",
      "scorers",
      "embedding",
      "hooks",
      "sandbox",
      "tools",
      "skill",
      "inputProcessors",
      "outputProcessors",
    ]);
    expect(new Set(MASTRA_AGENT_ZONES).size).toBe(MASTRA_AGENT_ZONES.length);
  });

  it.each(CASES)(
    "$name publishes kind/Agent-category and its zone connection port",
    ({ node, kind, inputs, outputs, connection }) => {
      const manifest = graphNodeManifest(node);
      expect(manifest.kind).toBe(kind);
      expect(manifest.display.category).toBe("Agent");
      expect(manifest.display.labels?.[0]).toBe("agent");
      expect(manifest.inputs.map((port) => port.id)).toEqual(inputs);
      expect(manifest.outputs.map((port) => port.id)).toEqual(outputs);

      const connections = manifest.connections ?? [];
      if (connection) {
        expect(connections.map((port) => port.id)).toEqual([connection[0]]);
        expect(connections[0].category).toBe(connection[1]);
      } else {
        expect(connections).toEqual([]);
      }
    }
  );
});

describe("Mastra AI-family nodes — execute (SAA-836 M3)", () => {
  const ctx = (kind: string) => buildNodeContext(kind);

  it("tool resolves its config into the mastra tool resource", async () => {
    const result = await executeNode(
      AgentToolNode,
      nodeExecutionRequest(
        {},
        { parameters: { toolId: "weather", description: "Get weather" } }
      ),
      ctx("core.agent.tool")
    );
    expect(result).toEqual({
      resource: {
        type: "mastra.tool",
        toolId: "weather",
        description: "Get weather",
        input: {},
      },
    });
  });

  it("toolSelector picks the decision string when it is a string", async () => {
    const result = await executeNode(
      AgentToolSelectorNode,
      nodeExecutionRequest(
        { decision: "b" },
        { parameters: { tools: ["a", "b"] } }
      ),
      ctx("core.agent.toolSelector")
    );
    expect(result).toEqual({
      selected: "b",
      resource: { type: "mastra.tool", toolId: "b" },
    });
  });

  it("toolSelector falls back to the first declared tool, and null when none", async () => {
    const withTools = await executeNode(
      AgentToolSelectorNode,
      nodeExecutionRequest({}, { parameters: { tools: ["a", "b"] } }),
      ctx("core.agent.toolSelector")
    );
    expect(withTools).toEqual({
      selected: "a",
      resource: { type: "mastra.tool", toolId: "a" },
    });

    const empty = await executeNode(
      AgentToolSelectorNode,
      nodeExecutionRequest({}, { parameters: {} }),
      ctx("core.agent.toolSelector")
    );
    expect(empty).toEqual({ selected: undefined, resource: null });
  });

  it("toolSelector ignores a non-string decision and uses the first tool", async () => {
    const result = await executeNode(
      AgentToolSelectorNode,
      nodeExecutionRequest({ decision: 42 }, { parameters: { tools: ["a"] } }),
      ctx("core.agent.toolSelector")
    );
    expect(result).toEqual({
      selected: "a",
      resource: { type: "mastra.tool", toolId: "a" },
    });
  });

  it("hook routes the tool-call context onto its sub-flow ports", async () => {
    const result = await executeNode(
      AgentHookNode,
      nodeExecutionRequest(
        { input: { q: 1 } },
        { parameters: { toolName: "search", phase: "before" } }
      ),
      ctx("core.agent.hook")
    );
    expect(result).toEqual({
      toolName: "search",
      input: { q: 1 },
      output: undefined,
      error: undefined,
      value: { input: { q: 1 } },
    });
  });

  it("hook prefers the routed toolName/value over its configured values", async () => {
    const result = await executeNode(
      AgentHookNode,
      nodeExecutionRequest(
        { toolName: "routed", value: "passthrough" },
        { parameters: { toolName: "configured" } }
      ),
      ctx("core.agent.hook")
    );
    expect(result["toolName"]).toBe("routed");
    expect(result["value"]).toBe("passthrough");
  });

  it("delegationHook routes the delegation context", async () => {
    const result = await executeNode(
      AgentDelegationHookNode,
      nodeExecutionRequest(
        { fromAgentId: "parent", input: { task: "x" } },
        { parameters: { subAgentId: "child", phase: "start" } }
      ),
      ctx("core.agent.delegationHook")
    );
    expect(result).toEqual({
      fromAgentId: "parent",
      toAgentId: "child",
      input: { task: "x" },
      output: undefined,
      error: undefined,
      value: { fromAgentId: "parent", input: { task: "x" } },
    });
  });

  it("toolDeny emits proceed:false with the replacement value", async () => {
    const result = await executeNode(
      AgentToolDenyNode,
      nodeExecutionRequest(
        { value: "original" },
        { parameters: { replacement: "denied-output", reason: "blocked" } }
      ),
      ctx("core.agent.toolDeny")
    );
    expect(result).toEqual({
      proceed: false,
      denied: true,
      reason: "blocked",
      value: "denied-output",
    });
  });

  it("toolDeny falls back to the incoming value when no replacement is configured", async () => {
    const result = await executeNode(
      AgentToolDenyNode,
      nodeExecutionRequest({ value: "original" }, { parameters: {} }),
      ctx("core.agent.toolDeny")
    );
    expect(result).toEqual({
      proceed: false,
      denied: true,
      reason: undefined,
      value: "original",
    });
  });

  it("skill resolves its config into the mastra skill resource", async () => {
    const result = await executeNode(
      AgentSkillNode,
      nodeExecutionRequest(
        {},
        { parameters: { name: "summarize", description: "Summarize text" } }
      ),
      ctx("core.agent.skill")
    );
    expect(result).toEqual({
      resource: {
        type: "mastra.skill",
        name: "summarize",
        description: "Summarize text",
        input: {},
      },
    });
  });

  it("skillSelector picks the decision string and falls back to the first skill", async () => {
    const byDecision = await executeNode(
      AgentSkillSelectorNode,
      nodeExecutionRequest(
        { decision: "b" },
        { parameters: { skills: ["a", "b"] } }
      ),
      ctx("core.agent.skillSelector")
    );
    expect(byDecision).toEqual({
      selected: "b",
      resource: { type: "mastra.skill", name: "b" },
    });

    const fallback = await executeNode(
      AgentSkillSelectorNode,
      nodeExecutionRequest({}, { parameters: { skills: ["a"] } }),
      ctx("core.agent.skillSelector")
    );
    expect(fallback).toEqual({
      selected: "a",
      resource: { type: "mastra.skill", name: "a" },
    });
  });

  it("scorer resolves its config into the mastra scorer resource", async () => {
    const result = await executeNode(
      AgentScorerNode,
      nodeExecutionRequest(
        {},
        {
          parameters: {
            scorerId: "accuracy",
            description: "Accuracy scorer",
            scorerType: "response",
          },
        }
      ),
      ctx("core.agent.scorer")
    );
    expect(result).toEqual({
      resource: {
        type: "mastra.scorer",
        id: "accuracy",
        description: "Accuracy scorer",
        scorerType: "response",
        input: {},
      },
    });
  });

  it("scorerSelector picks the decision string and falls back to the first scorer", async () => {
    const byDecision = await executeNode(
      AgentScorerSelectorNode,
      nodeExecutionRequest(
        { decision: "toxicity" },
        { parameters: { scorers: ["accuracy", "toxicity"] } }
      ),
      ctx("core.agent.scorerSelector")
    );
    expect(byDecision).toEqual({
      selected: "toxicity",
      resource: { type: "mastra.scorer", id: "toxicity" },
    });

    const fallback = await executeNode(
      AgentScorerSelectorNode,
      nodeExecutionRequest({}, { parameters: { scorers: ["accuracy"] } }),
      ctx("core.agent.scorerSelector")
    );
    expect(fallback).toEqual({
      selected: "accuracy",
      resource: { type: "mastra.scorer", id: "accuracy" },
    });
  });

  it("sandbox resolves a within-ceiling timeout unchanged", async () => {
    const result = await executeNode(
      AgentSandboxNode,
      nodeExecutionRequest(
        {},
        {
          parameters: {
            workingDirectory: "/work",
            isolation: "bwrap",
            timeoutMs: 5000,
          },
        }
      ),
      ctx("core.agent.sandbox")
    );
    expect(result).toEqual({
      resource: {
        type: "mastra.sandbox",
        workingDirectory: "/work",
        isolation: "bwrap",
        timeoutMs: 5000,
        input: {},
      },
    });
  });

  it("sandbox clamps an over-ceiling timeout to the code ceiling", async () => {
    const result = await executeNode(
      AgentSandboxNode,
      nodeExecutionRequest({}, { parameters: { timeoutMs: 50000 } }),
      ctx("core.agent.sandbox")
    );
    expect(
      (result["resource"] as { timeoutMs: number }).timeoutMs
    ).toBe(GRAPH_CODE_MAX_TIMEOUT_MS);
  });

  it("sandbox falls back to the code default for a missing/invalid timeout", async () => {
    for (const timeoutMs of [undefined, 0, -5, NaN]) {
      const result = await executeNode(
        AgentSandboxNode,
        nodeExecutionRequest({}, { parameters: { timeoutMs } }),
        ctx("core.agent.sandbox")
      );
      expect(
        (result["resource"] as { timeoutMs: number }).timeoutMs
      ).toBe(GRAPH_CODE_DEFAULT_TIMEOUT_MS);
    }
  });
});

describe("clampSandboxTimeoutMs (SAA-836 M3)", () => {
  afterAll(() => {
    GraphEnvironment.accumulate({
      graph: { execution: { maxCodeTimeoutMs: GRAPH_CODE_MAX_TIMEOUT_MS } },
    } as never);
  });

  it("uses the code ceiling by default and floors fractional values", () => {
    expect(clampSandboxTimeoutMs(2500)).toBe(2500);
    expect(clampSandboxTimeoutMs(2500.9)).toBe(2500);
    expect(clampSandboxTimeoutMs(50000)).toBe(GRAPH_CODE_MAX_TIMEOUT_MS);
  });

  it("falls back to the code default for a missing or invalid value", () => {
    expect(clampSandboxTimeoutMs(undefined)).toBe(GRAPH_CODE_DEFAULT_TIMEOUT_MS);
    expect(clampSandboxTimeoutMs(null)).toBe(GRAPH_CODE_DEFAULT_TIMEOUT_MS);
    expect(clampSandboxTimeoutMs(NaN)).toBe(GRAPH_CODE_DEFAULT_TIMEOUT_MS);
    expect(clampSandboxTimeoutMs(0)).toBe(GRAPH_CODE_DEFAULT_TIMEOUT_MS);
  });

  it("honours the GraphEnvironment maxCodeTimeoutMs ceiling override", () => {
    GraphEnvironment.accumulate({
      graph: { execution: { maxCodeTimeoutMs: 2000 } },
    } as never);
    try {
      expect(clampSandboxTimeoutMs(50000)).toBe(2000);
      expect(clampSandboxTimeoutMs(1500)).toBe(1500);
    } finally {
      GraphEnvironment.accumulate({
        graph: { execution: { maxCodeTimeoutMs: GRAPH_CODE_MAX_TIMEOUT_MS } },
      } as never);
    }
  });
});
