/**
 * @module as-graph/tests/integration/graph/generalEngineIoNodes.test
 * @summary Integration coverage for the SAA-746 Stage 1 IO/flow nodes.
 * @description Executes `core.io.respondToWebhook` through the real engine so
 * the run-keyed `GraphWebhookResponseRegistry` delivers the response, and proves
 * `core.flow.executeSubWorkflow` round-trips a real child graph inline, through
 * `workflowId`/`engine.getWorkflow`, and in `perItem` aggregation mode.
 */
import { describe, it, expect } from "@jest/globals";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { registerBuiltInGraphNodes } from "../../../src/engine/catalog/GraphBuiltInRegistrations";
import type { GraphBackendWorkflowStore } from "../../../src/engine/execution/GraphExecutionBackend";
import {
  bootEngine,
  documentEdge,
  documentNode,
  documentPort,
  freshCatalogue,
} from "../../unit/graph/engine-fixtures";

async function bootBuiltInEngine(extra: {
  workflowStore?: GraphBackendWorkflowStore;
} = {}): Promise<GraphExecutionEngine> {
  const catalogue = freshCatalogue();
  const engine = await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    ...extra,
  });
  await registerBuiltInGraphNodes(catalogue);
  return engine;
}

function childDocument(): GraphWorkflowDocument {
  return {
    id: "child-wf",
    name: "child-wf",
    inputs: [documentPort("value")],
    outputs: [documentPort("result")],
    nodes: [documentNode("limit", "core.data.limit", { maxItems: 1 })],
    edges: [
      documentEdge("c-in", ["workflow", "value"], ["node", "limit", "value"]),
      documentEdge("c-out", ["node", "limit", "result"], ["workflow", "result"]),
    ],
  };
}

function subWorkflowParent(parameters: Record<string, unknown>): GraphWorkflowDocument {
  return {
    id: "parent-wf",
    name: "parent-wf",
    inputs: [documentPort("value")],
    outputs: [documentPort("result")],
    nodes: [
      documentNode("sub", "core.flow.executeSubWorkflow", parameters),
    ],
    edges: [
      documentEdge("p-in", ["workflow", "value"], ["node", "sub", "value"]),
      documentEdge("p-out", ["node", "sub", "result"], ["workflow", "result"]),
    ],
  };
}

describe("core.io.respondToWebhook through the engine", () => {
  it("delivers the node response to the registered run", async () => {
    const engine = await bootBuiltInEngine();
    const document: GraphWorkflowDocument = {
      id: "wf-webhook",
      name: "wf-webhook",
      inputs: [documentPort("value")],
      outputs: [],
      nodes: [
        documentNode("respond", "core.io.respondToWebhook", {
          respondWith: "json",
          responseCode: 202,
          responseHeaders: { "x-test-header": "structured" },
          responseBody: { custom: "body" },
        }),
      ],
      edges: [
        documentEdge("w-in", ["workflow", "value"], ["node", "respond", "value"]),
      ],
    };

    const pending = engine.webhookResponses.register("webhook-run", 5000);
    const result = await engine.execute(
      document,
      { value: { hello: "world" } },
      { runId: "webhook-run" }
    );

    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.respond.outputs?.delivered).toBe(true);
    await expect(pending).resolves.toMatchObject({
      statusCode: 202,
      headers: {
        "content-type": "application/json",
        "x-test-header": "structured",
      },
      body: { custom: "body" },
      runId: "webhook-run",
    });
  });
});

describe("core.flow.executeSubWorkflow through the engine", () => {
  it("round-trips an inline child document", async () => {
    const engine = await bootBuiltInEngine();
    // D2: the published manifest declares `workflow` as an object, so the
    // canonical document carries the inline child directly in `parameters`.
    const parent = subWorkflowParent({
      inputPort: "value",
      workflow: childDocument(),
    });
    const result = await engine.execute(parent, { value: [3, 4] });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toEqual([3]);
    expect(result.nodeResults.sub.outputs?.result).toEqual([3]);
    expect(result.nodeResults.sub.outputs?.childRunId).toEqual(expect.any(String));
    expect(result.nodeResults.sub.outputs?.childRunId).not.toBe(result.runId);
  });

  it("resolves the child through workflowId and engine.getWorkflow", async () => {
    const child = childDocument();
    const workflowStore: GraphBackendWorkflowStore = {
      listWorkflows: async () => [],
      getDocument: async (workflowId: string) => {
        if (workflowId !== child.id) throw new Error(`unknown workflow '${workflowId}'`);
        return child;
      },
    };
    const engine = await bootBuiltInEngine({ workflowStore });
    expect(await engine.getWorkflow("child-wf")).toBe(child);

    const result = await engine.execute(
      subWorkflowParent({ workflowId: "child-wf" }),
      { value: [5, 6] }
    );
    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toEqual([5]);
  });

  it("aggregates perItem child runs into one result array", async () => {
    const engine = await bootBuiltInEngine();
    const parent = subWorkflowParent({
      mode: "perItem",
      inputPort: "value",
      workflow: childDocument(),
    });
    const result = await engine.execute(parent, { value: [1, 2] });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toEqual([[1], [2]]);
    const outputs = result.nodeResults.sub.outputs as {
      result: unknown[];
      childRunId: string;
    };
    expect(outputs.result).toHaveLength(2);
    expect(outputs.childRunId).toEqual(expect.any(String));
    expect(outputs.childRunId).not.toBe(result.runId);
  });
});
