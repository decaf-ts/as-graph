/**
 * @module as-graph/tests/evals/core-agent
 * @summary SAA-836 E1 eval for the `core.agent` agent kind (M1 agent core):
 * mastra datasets/experiments run a `core.trigger.chat -> core.agent` document
 * through the real `MastraGraphExecutionBackend` and record the experiment +
 * per-item results for the agent's execution.
 * @description Real: the production backend, compiler, and default handler set
 * (real `@mastra/core` `createStep`), a real mastra dataset + experiment
 * persisted in mastra storage, and a real agent turn. The deterministic suite
 * runs a stub agent (no model provider — R1); the single guarded live suite
 * injects the real `pdm_ai` router model (`glm-5.3-flash`) through the
 * `@ai-sdk/openai-compatible` provider (the 1-eval pipeline smoke — Scope
 * addition 4). The API key is read at test time from the opencode config
 * (`~/.config/opencode/opencode.json`) or `PDM_AI_API_KEY` and is never
 * logged, echoed, or asserted.
 */
import { describe, it, expect } from "@jest/globals";
import { createScorer, type MastraScorer } from "@mastra/core/evals";
import {
  createLiveAgentFactory,
  createStubAgentFactory,
  document,
  edge,
  liveProviderConfig,
  node,
  runGraphEval,
  type GraphTaskOutput,
} from "./helpers";
import { LIVE_MODEL_ID, LIVE_PROVIDER } from "./helpers";

/** A `core.trigger.chat -> core.agent` document carrying a model adapter. */
function chatAgentDocument(id: string): ReturnType<typeof document> {
  return document({
    id,
    name: id,
    nodes: [
      node("chat", "core.trigger.chat"),
      node("agent", "core.agent", {
        modelAdapter: { provider: LIVE_PROVIDER, modelId: LIVE_MODEL_ID },
      }),
    ],
    edges: [
      edge("e1", ["node", "chat", "message"], ["node", "agent", "prompt"]),
    ],
  });
}

/**
 * The agent-response scorer: 1.0 when the agent node produced a non-empty
 * `response` output, 0.0 otherwise.
 *
 * @returns The mastra scorer.
 */
function agentResponseScorer(): MastraScorer {
  return createScorer({
    id: "agent-response-present",
    description: "1.0 when the agent produced a non-empty response",
  }).generateScore(({ run }) => {
    const output = run.output as GraphTaskOutput | undefined;
    const response = output?.outputs?.["agent"]?.["response"];
    return typeof response === "string" && response.length > 0 ? 1 : 0;
  });
}

describe("mastra eval — core.agent (core-agent, deterministic stub agent)", () => {
  it(
    "runs a mastra experiment recording the agent's response outputs",
    async () => {
      const report = await runGraphEval({
        evalId: "core-agent",
        kind: "core.agent",
        document: chatAgentDocument("core-agent"),
        items: [
          { id: "greet", input: { message: "Say hello to the eval harness" } },
          { id: "pong", input: { message: "Reply with exactly one word: pong" } },
        ],
        backendConfig: { createAgent: createStubAgentFactory() as never },
        scorers: [agentResponseScorer()],
        description: "SAA-836 E1 eval for the core.agent agent kind (stub agent)",
      });

      // The experiment itself completed and recorded results.
      expect(report.status).toBe("completed");
      expect(report.totalItems).toBe(report.itemResults.length);
      expect(report.failedCount).toBe(0);
      expect(report.succeededCount).toBe(report.totalItems);
      // The agent node produced a response on every item.
      for (const itemResult of report.itemResults) {
        const output = report.outputs[itemResult.itemId];
        expect(typeof output?.outputs?.["agent"]?.["response"]).toBe("string");
        expect((output?.outputs?.["agent"]?.["response"] as string).length).toBeGreaterThan(0);
      }
      // The O1 projection read the persisted experiment row back.
      expect(report.projectedExperiment?.["experimentId"]).toBe(report.experimentId);
      expect(report.projectedResults.length).toBeGreaterThan(0);
    },
    60000
  );
});

const liveFactory = liveProviderConfig ? createLiveAgentFactory(liveProviderConfig) : undefined;
const describeLive = liveProviderConfig && liveFactory ? describe : describe.skip;

describeLive("mastra eval — core.agent (core-agent, live pdm_ai pipeline smoke)", () => {
  it(
    "runs the single live chat -> agent experiment through the real router model",
    async () => {
      const report = await runGraphEval({
        evalId: "core-agent-live",
        kind: "core.agent",
        document: chatAgentDocument("core-agent-live"),
        items: [
          { id: "smoke", input: { message: "Reply with exactly one word: pong" } },
        ],
        backendConfig: { createAgent: liveFactory as never },
        scorers: [agentResponseScorer()],
        description:
          "SAA-836 E1 single live pipeline-smoke eval (pdm_ai glm-5.3-flash)",
      });

      // Report (never the key value).
      console.log(
        `[live-eval] model=${LIVE_MODEL_ID} provider=${LIVE_PROVIDER} keySource=${
          process.env["PDM_AI_API_KEY"] ? "env" : "config"
        } experiment=${report.experimentId} status=${report.status} succeeded=${report.succeededCount}/${report.totalItems}${
          report.failure ? ` failure=${JSON.stringify(report.failure)}` : ""
        }`
      );

      // The single live experiment completed and recorded the agent's response.
      expect(report.status).toBe("completed");
      expect(report.totalItems).toBe(1);
      expect(report.failedCount).toBe(0);
      expect(report.succeededCount).toBe(1);
      const output = report.outputs[report.itemResults[0]?.itemId ?? ""];
      expect(typeof output?.outputs?.["agent"]?.["response"]).toBe("string");
      expect((output?.outputs?.["agent"]?.["response"] as string).length).toBeGreaterThan(0);
      expect(report.projectedExperiment?.["experimentId"]).toBe(report.experimentId);
      expect(report.projectedResults.length).toBe(1);
    },
    120000
  );
});
