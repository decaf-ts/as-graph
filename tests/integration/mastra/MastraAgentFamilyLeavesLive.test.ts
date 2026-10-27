/**
 * @module as-graph/tests/integration/mastra/MastraAgentFamilyLeavesLive
 * @summary SAA-1144 live integration coverage for the eight mastra
 * agent-family leaf kinds that previously had unit coverage only.
 * @description Executes each production node class through the shared
 * `runNode` harness and asserts the real resource/selection projection the
 * mastra backend consumes. These leaves are configuration/descriptor kinds:
 * they have no external service dependency, so the live backing is the real
 * node implementation (no mock, no descriptor fabricated by the test).
 */
import { describe, expect, it } from "@jest/globals";
import { GRAPH_CODE_MAX_TIMEOUT_MS } from "../../../src/engine/constants";
import { AgentToolSelectorNode } from "../../../src/mastra/nodes/tools/tool-selector/node";
import { AgentToolDenyNode } from "../../../src/mastra/nodes/hooks/tool-deny/node";
import { AgentDelegationHookNode } from "../../../src/mastra/nodes/hooks/delegation/node";
import { AgentSkillNode } from "../../../src/mastra/nodes/skills/skill/node";
import { AgentSkillSelectorNode } from "../../../src/mastra/nodes/skills/skill-selector/node";
import { AgentScorerNode } from "../../../src/mastra/nodes/scorers/scorer/node";
import { AgentScorerSelectorNode } from "../../../src/mastra/nodes/scorers/scorer-selector/node";
import { createMastraRagStepHandlers } from "../../../src/mastra/MastraRagStepHandlers";
import { MastraWorkflowCompiler } from "../../../src/mastra/MastraWorkflowCompiler";
import { document, node } from "../../../src/workflows/builders";
import { runNode } from "../graph/nodes/real-service-support";

const LIVE_BACKING = "in-process real node (mastra descriptor kind)";

describe(`core.agent.toolSelector — live node (${LIVE_BACKING})`, () => {
  it("selects the requested tool and resolves its resource", async () => {
    const result = await runNode(
      AgentToolSelectorNode,
      "core.agent.toolSelector",
      { tools: ["weather", "search"] },
      { decision: "search" }
    );
    expect(result.selected).toBe("search");
    expect(result.resource).toEqual({ type: "mastra.tool", toolId: "search" });
  });
});

describe(`core.agent.toolDeny — live node (${LIVE_BACKING})`, () => {
  it("denies the call and substitutes the configured replacement", async () => {
    const replacement = { blocked: true, reason: "policy" };
    const result = await runNode(
      AgentToolDenyNode,
      "core.agent.toolDeny",
      { reason: "policy", replacement },
      { value: "original" }
    );
    expect(result).toEqual({
      proceed: false,
      denied: true,
      reason: "policy",
      value: replacement,
    });
  });
});

describe(`core.agent.delegationHook — live node (${LIVE_BACKING})`, () => {
  it("routes the delegation context onto the sub-agent", async () => {
    const result = await runNode(
      AgentDelegationHookNode,
      "core.agent.delegationHook",
      { phase: "start", subAgentId: "agent-b" },
      { fromAgentId: "agent-a", input: { question: "hi" } }
    );
    expect(result).toMatchObject({
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      input: { question: "hi" },
    });
  });
});

describe(`core.agent.skill — live node (${LIVE_BACKING})`, () => {
  it("resolves the configured skill descriptor", async () => {
    const result = await runNode(
      AgentSkillNode,
      "core.agent.skill",
      { name: "summarizer", description: "summarizes" },
      { text: "long text" }
    );
    expect(result.resource).toEqual({
      type: "mastra.skill",
      name: "summarizer",
      description: "summarizes",
      input: { text: "long text" },
    });
  });
});

describe(`core.agent.skillSelector — live node (${LIVE_BACKING})`, () => {
  it("selects a skill by decision", async () => {
    const result = await runNode(
      AgentSkillSelectorNode,
      "core.agent.skillSelector",
      { skills: ["summarizer", "translator"] },
      { decision: "translator" }
    );
    expect(result).toEqual({
      selected: "translator",
      resource: { type: "mastra.skill", name: "translator" },
    });
  });
});

describe(`core.agent.sandbox — live node (${LIVE_BACKING})`, () => {
  it("resolves the sandbox descriptor and clamps the timeout ceiling", async () => {
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: createMastraRagStepHandlers(),
    });
    const { steps } = compiler.compile(
      document({
        id: "saa-1144-sandbox-live",
        name: "saa-1144-sandbox-live",
        nodes: [
          node("target", "core.agent.sandbox", {
            workingDirectory: "/tmp",
            isolation: "process",
            timeoutMs: Number.MAX_SAFE_INTEGER,
          }),
        ],
      })
    );
    const result = (await (
      steps.get("target") as {
        execute: (args: { inputData?: unknown }) => Promise<Record<string, unknown>>;
      }
    ).execute({ inputData: {} })) as { resource: Record<string, unknown> };
    expect(result.resource).toMatchObject({
      type: "mastra.sandbox",
      workingDirectory: "/tmp",
      isolation: "process",
      timeoutMs: GRAPH_CODE_MAX_TIMEOUT_MS,
    });
  });
});

describe(`core.agent.scorer — live node (${LIVE_BACKING})`, () => {
  it("resolves the configured scorer descriptor", async () => {
    const result = await runNode(
      AgentScorerNode,
      "core.agent.scorer",
      {
        scorerId: "toxicity",
        description: "flags toxic output",
        scorerType: "classification",
      },
      { text: "hello" }
    );
    expect(result.resource).toEqual({
      type: "mastra.scorer",
      id: "toxicity",
      description: "flags toxic output",
      scorerType: "classification",
      input: { text: "hello" },
    });
  });
});

describe(`core.agent.scorerSelector — live node (${LIVE_BACKING})`, () => {
  it("selects a scorer by decision", async () => {
    const result = await runNode(
      AgentScorerSelectorNode,
      "core.agent.scorerSelector",
      { scorers: ["toxicity", "relevance"] },
      { decision: "relevance" }
    );
    expect(result).toEqual({
      selected: "relevance",
      resource: { type: "mastra.scorer", id: "relevance" },
    });
  });
});
