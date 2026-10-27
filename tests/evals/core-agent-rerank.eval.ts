/**
 * @module as-graph/tests/evals/core-agent-rerank
 * @summary SAA-836 E1 / SAA-1547 §7 eval for the `core.agent.rerank` agent
 * kind: a mastra dataset/experiment runs the kind's single-node document
 * through the real `MastraGraphExecutionBackend` with a deterministic host
 * reranker and records the experiment + per-item results.
 * @description Real: the production backend, compiler, and registry node step
 * adapter (real `@mastra/core` `createStep`), and a real mastra dataset +
 * experiment persisted in mastra storage. Deterministic and provider-free (R1):
 * the host `MastraBackendConfig.rerankDocuments` port is a local fake, so the
 * eval asserts the ranked order/scores without a model call. Without that host
 * reranker the node correctly fails closed with `GRAPH_MASTRA_RAG_UNAVAILABLE`.
 */
import { describe, expect, it } from "@jest/globals";
import { GraphExecutionStatus } from "../../src/shared/graph/constants";
import type { MastraRerankRequest } from "../../src/mastra/MastraRagStepHandlers";
import {
  resourceDescriptorDocument,
  runGraphEval,
} from "./helpers";

const EVAL_ID = "core-agent-rerank";
const KIND = "core.agent.rerank";
const MODEL_ADAPTER = { provider: "deterministic", modelId: "rerank-v1" };

describe(`mastra eval — ${KIND} (${EVAL_ID})`, () => {
  it(
    "runs a mastra experiment that ranks through the host reranker and records order/scores",
    async () => {
      const requests: MastraRerankRequest[] = [];
      const report = await runGraphEval({
        evalId: EVAL_ID,
        kind: KIND,
        document: resourceDescriptorDocument(EVAL_ID, KIND, {
          query: "alpha",
          documents: [
            { text: "gamma" },
            { text: "alpha" },
            { text: "beta" },
          ],
          topN: 2,
          modelAdapter: MODEL_ADAPTER,
        }),
        items: [{ id: "probe", input: {} }],
        backendConfig: {
          rerankDocuments: async (request) => {
            requests.push(request);
            return [
              { document: { text: "alpha" }, score: 0.9 },
              { document: { text: "beta" }, score: 0.5 },
              { document: { text: "gamma" }, score: 0.1 },
            ];
          },
        },
        description: `SAA-1547 §7 eval for the ${KIND} agent kind`,
      });

      expect(report.status).toBe("completed");
      expect(report.totalItems).toBe(report.itemResults.length);
      expect(report.failedCount).toBe(0);
      expect(report.succeededCount).toBe(report.totalItems);
      for (const itemResult of report.itemResults) {
        expect(itemResult.scores.length).toBeGreaterThan(0);
        for (const score of itemResult.scores) {
          expect(score.score).toBe(1);
        }
      }
      expect(report.projectedExperiment?.["experimentId"]).toBe(
        report.experimentId
      );
      expect(report.projectedResults.length).toBeGreaterThan(0);

      // The host reranker was consulted with the node's declared documents and
      // topN, and the step projected the ranked order/scores.
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        query: "alpha",
        topN: 2,
        documents: [
          { text: "gamma" },
          { text: "alpha" },
          { text: "beta" },
        ],
      });
      const taskOutput = Object.values(report.outputs)[0];
      const nodeOutput = taskOutput?.outputs?.["subject"];
      expect(nodeOutput?.["documents"]).toEqual([
        { text: "alpha" },
        { text: "beta" },
      ]);
      expect(nodeOutput?.["scores"]).toEqual([0.9, 0.5]);
      expect(nodeOutput?.["resource"]).toMatchObject({
        kind: KIND,
        type: "mastra.rerank",
        provider: "deterministic",
        modelId: "rerank-v1",
        topN: 2,
      });
      expect(taskOutput?.status).toBe(GraphExecutionStatus.SUCCEEDED);
    },
    60000
  );
});
