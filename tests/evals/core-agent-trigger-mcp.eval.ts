/**
 * @module as-graph/tests/evals/core-agent-trigger-mcp
 * @summary SAA-836 E1 eval for the `core.agent.trigger.mcp` agent kind (M5
 * MCP Server Trigger): a mastra dataset/experiment runs the kind's document
 * through the real `MastraGraphExecutionBackend` and records the experiment +
 * per-item results for the MCP serving surface the host factory produces.
 * @description Real: the production backend, compiler, dedicated MCP trigger
 * step handler, and a real mastra dataset + experiment persisted in mastra
 * storage. Host-injected: the `createMcpServer` factory (the declared R2
 * extension point — `@mastra/mcp` is not vendored) supplies the server surface
 * the step resolves the descriptor against and exposes as its `resource`
 * output. Deterministic (no model provider — R1).
 */
import { describe, it, expect } from "@jest/globals";
import { createScorer, type MastraScorer } from "@mastra/core/evals";
import {
  document,
  node,
  runGraphEval,
  type GraphTaskOutput,
} from "./helpers";

/** The MCP Server Trigger document under eval. */
function mcpTriggerDocument(id: string): ReturnType<typeof document> {
  return document({
    id,
    name: id,
    nodes: [
      node("mcp", "core.agent.trigger.mcp", {
        serverId: "as-graph-eval-gateway",
        title: "As-Graph Eval MCP Gateway",
        instructions: "Serve the enclosing workflow over MCP",
        transport: "http",
      }),
    ],
  });
}

/**
 * The MCP-serving scorer: 1.0 when the trigger served the workflow through the
 * host factory's server surface (the step's `resource` output carries the
 * served gateway), 0.0 otherwise.
 *
 * @returns The mastra scorer.
 */
function mcpServedScorer(): MastraScorer {
  return createScorer({
    id: "mcp-served",
    description: "1.0 when the trigger served the gateway surface",
  }).generateScore(({ run }) => {
    const output = run.output as GraphTaskOutput | undefined;
    const resource = output?.outputs?.["mcp"]?.["resource"] as
      | { kind?: unknown }
      | undefined;
    return resource?.kind === "fake-mcp-server" ? 1 : 0;
  });
}

describe("mastra eval — core.agent.trigger.mcp (core-agent-trigger-mcp)", () => {
  it(
    "runs a mastra experiment recording the MCP serving surface",
    async () => {
      const report = await runGraphEval({
        evalId: "core-agent-trigger-mcp",
        kind: "core.agent.trigger.mcp",
        document: mcpTriggerDocument("core-agent-trigger-mcp"),
        items: [{ id: "serve", input: {} }],
        backendConfig: {
          createMcpServer: () => ({ kind: "fake-mcp-server", tools: [] }),
        },
        scorers: [mcpServedScorer()],
        description: "SAA-836 E1 eval for the core.agent.trigger.mcp agent kind",
      });

      // The experiment itself completed and recorded results.
      expect(report.status).toBe("completed");
      expect(report.totalItems).toBe(1);
      expect(report.failedCount).toBe(0);
      expect(report.succeededCount).toBe(1);
      // Every scorer scored 1.0 (the gateway was served through the factory).
      for (const itemResult of report.itemResults) {
        expect(itemResult.scores.length).toBeGreaterThan(0);
        for (const score of itemResult.scores) {
          expect(score.score).toBe(1);
        }
      }
      // The served gateway surface is the step's `resource` output.
      const output = report.outputs[report.itemResults[0]?.itemId ?? ""];
      expect(output?.outputs?.["mcp"]?.["resource"]).toEqual({
        kind: "fake-mcp-server",
        tools: [],
      });
      // The O1 projection read the persisted experiment row back.
      expect(report.projectedExperiment?.["experimentId"]).toBe(report.experimentId);
      expect(report.projectedResults.length).toBeGreaterThan(0);
    },
    60000
  );
});
