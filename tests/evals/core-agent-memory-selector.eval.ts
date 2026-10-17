/**
 * @module as-graph/tests/evals/core-agent-memory-selector
 * @summary SAA-836 E1 eval for the `core.agent.memorySelector` agent kind (M2
 * memory decision sub-flow): a mastra dataset/experiment runs the kind's
 * document through the real `MastraGraphExecutionBackend` and records the
 * experiment + per-item results for the selection surface — a string decision
 * selects the memory id, otherwise the first declared candidate, and
 * `resource` carries the selected memory's JSON-safe descriptor.
 * @description Real: the production backend, compiler, and default handler set
 * (real `@mastra/core` `createStep`), and a real mastra dataset + experiment
 * persisted in mastra storage. Deterministic (no model provider — R1): the
 * step resolves the selection, it does not call a model.
 */
import { describe, it, expect } from "@jest/globals";
import { createScorer, type MastraScorer } from "@mastra/core/evals";
import {
  document,
  node,
  runGraphEval,
  type GraphTaskOutput,
} from "./helpers";

/**
 * The memory-selection scorer: 1.0 when the selector picked the declared
 * first candidate and its `resource` carries the selected memory's JSON-safe
 * descriptor, 0.0 otherwise.
 *
 * @returns The mastra scorer.
 */
function memorySelectionScorer(): MastraScorer {
  return createScorer({
    id: "memory-selection",
    description: "1.0 when the selector selected the declared candidate",
  }).generateScore(({ run }) => {
    const output = run.output as GraphTaskOutput | undefined;
    const nodeOutputs = output?.outputs?.["subject"] as
      | { selected?: unknown; resource?: { type?: unknown; id?: unknown } | null }
      | undefined;
    return nodeOutputs?.selected === "primary" &&
      nodeOutputs?.resource?.type === "mastra.memory" &&
      nodeOutputs?.resource?.id === "primary"
      ? 1
      : 0;
  });
}

describe("mastra eval — core.agent.memorySelector (core-agent-memory-selector)", () => {
  it(
    "runs a mastra experiment recording the memory selection surface",
    async () => {
      const report = await runGraphEval({
        evalId: "core-agent-memory-selector",
        kind: "core.agent.memorySelector",
        document: document({
          id: "core-agent-memory-selector",
          name: "core-agent-memory-selector",
          nodes: [
            node("subject", "core.agent.memorySelector", {
              memories: ["primary", "fallback"],
            }),
          ],
          edges: [],
        }),
        items: [{ id: "select", input: {} }],
        scorers: [memorySelectionScorer()],
        description:
          "SAA-836 E1 eval for the core.agent.memorySelector agent kind",
      });

      // The experiment itself completed and recorded results.
      expect(report.status).toBe("completed");
      expect(report.totalItems).toBe(1);
      expect(report.failedCount).toBe(0);
      expect(report.succeededCount).toBe(1);
      // Every scorer scored 1.0 (the selection resolved to the candidate).
      for (const itemResult of report.itemResults) {
        expect(itemResult.scores.length).toBeGreaterThan(0);
        for (const score of itemResult.scores) {
          expect(score.score).toBe(1);
        }
      }
      // The O1 projection read the persisted experiment row back.
      expect(report.projectedExperiment?.["experimentId"]).toBe(report.experimentId);
      expect(report.projectedResults.length).toBeGreaterThan(0);
    },
    60000
  );
});
