/**
 * @module as-graph/tests/evals/core-agent-hitl
 * @summary SAA-836 E1 eval for the `core.agent.hitl` agent kind (M5
 * human-in-the-loop): a mastra dataset/experiment runs the kind's suspendable
 * document through the real `MastraGraphExecutionBackend` and records the
 * experiment + per-item results for the suspend surface mastra records.
 * @description Real: the production backend, compiler, dedicated HITL step
 * handler (real mastra suspend/resume semantics), and a real mastra dataset +
 * experiment persisted in mastra storage. Deterministic (no model provider —
 * R1): the eval exercises the suspend surface (the message/prompt payload
 * mastra records); the resume path itself is covered by the production resume
 * integration suite.
 */
import { describe, it, expect } from "@jest/globals";
import { createScorer, type MastraScorer } from "@mastra/core/evals";
import {
  document,
  node,
  runGraphEval,
  type GraphTaskOutput,
} from "./helpers";

/** A HITL document: a single human-in-the-loop node. */
function hitlDocument(id: string): ReturnType<typeof document> {
  return document({
    id,
    name: id,
    nodes: [
      node("hitl", "core.agent.hitl", {
        message: "Need a human decision",
        prompt: "Approve the refund?",
        resumeSchema: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
            value: { type: "string" },
          },
        },
      }),
    ],
  });
}

/**
 * The suspend-payload scorer: 1.0 when the run suspended at the hitl node with
 * the declared message/prompt payload, 0.0 otherwise.
 *
 * @returns The mastra scorer.
 */
function hitlSuspendScorer(): MastraScorer {
  return createScorer({
    id: "hitl-suspend-payload",
    description: "1.0 when the run suspended with the declared message/prompt",
  }).generateScore(({ run }) => {
    const output = run.output as GraphTaskOutput | undefined;
    const suspend = output?.suspends?.["hitl"];
    return suspend?.["message"] === "Need a human decision" &&
      suspend?.["prompt"] === "Approve the refund?"
      ? 1
      : 0;
  });
}

describe("mastra eval — core.agent.hitl (core-agent-hitl)", () => {
  it(
    "runs a mastra experiment recording the HITL suspend surface",
    async () => {
      const report = await runGraphEval({
        evalId: "core-agent-hitl",
        kind: "core.agent.hitl",
        document: hitlDocument("core-agent-hitl"),
        items: [{ id: "approval", input: {} }],
        scorers: [hitlSuspendScorer()],
        description: "SAA-836 E1 eval for the core.agent.hitl agent kind",
      });

      // The experiment itself completed and recorded results.
      expect(report.status).toBe("completed");
      expect(report.totalItems).toBe(1);
      expect(report.failedCount).toBe(0);
      expect(report.succeededCount).toBe(1);
      // Every scorer scored 1.0 (the run suspended with the declared payload).
      for (const itemResult of report.itemResults) {
        expect(itemResult.scores.length).toBeGreaterThan(0);
        for (const score of itemResult.scores) {
          expect(score.score).toBe(1);
        }
      }
      // The suspend surface was recorded on the task output.
      const output = report.outputs[report.itemResults[0]?.itemId ?? ""];
      expect(output?.suspends?.["hitl"]).toEqual({
        message: "Need a human decision",
        prompt: "Approve the refund?",
      });
      // The O1 projection read the persisted experiment row back.
      expect(report.projectedExperiment?.["experimentId"]).toBe(report.experimentId);
      expect(report.projectedResults.length).toBeGreaterThan(0);
    },
    60000
  );
});
