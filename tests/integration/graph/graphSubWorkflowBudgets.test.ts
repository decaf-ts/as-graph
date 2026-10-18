/**
 * @module as-graph/tests/integration/graph/graphSubWorkflowBudgets
 * @summary C7 regression coverage for SAA-958: sub-workflow depth and child-run
 * budgets, and the rule that loop bodies do not consume sub-workflow depth.
 * @description Boots the real engine over the local backend and built-in node
 * catalogue. A self-referential saved workflow must stop with
 * `GRAPH_SUB_WORKFLOW_DEPTH_EXCEEDED`; a `perItem` fan-out past `maxChildRuns`
 * must stop with `GRAPH_SUB_WORKFLOW_CHILD_LIMIT_EXCEEDED`; and a foreach body
 * run at `maxSubWorkflowDepth: 0` must still succeed because loop iterations
 * are not sub-workflow edges.
 */
import { describe, it, expect } from "@jest/globals";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import type { GraphBackendWorkflowStore } from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { registerBuiltInGraphNodes } from "../../../src/engine/catalog/GraphBuiltInRegistrations";
import {
  bootEngine,
  documentEdge,
  documentNode,
  documentPort,
  freshCatalogue,
} from "../../unit/graph/engine-fixtures";

function delayChild(id = "child-wf"): GraphWorkflowDocument {
  return {
    id,
    name: id,
    inputs: [documentPort("value")],
    outputs: [documentPort("result")],
    nodes: [documentNode("echo", "core.flow.delay", {})],
    edges: [
      documentEdge("c0", ["workflow", "value"], ["node", "echo", "value"]),
      documentEdge("c1", ["node", "echo", "value"], ["workflow", "result"]),
    ],
  };
}

function savedStore(
  documents: Record<string, GraphWorkflowDocument>
): GraphBackendWorkflowStore {
  return {
    listWorkflows: async () => [],
    getDocument: async (workflowId: string) => {
      const document = documents[workflowId];
      if (!document) throw new Error(`missing workflow '${workflowId}'`);
      return document;
    },
  };
}

function selfReferenceDocument(id = "self-ref"): GraphWorkflowDocument {
  return {
    id,
    name: id,
    inputs: [documentPort("value")],
    outputs: [documentPort("result")],
    nodes: [
      documentNode("sub", "core.flow.executeSubWorkflow", {
        workflowId: id,
        mode: "once",
      }),
    ],
    edges: [
      documentEdge("e0", ["workflow", "value"], ["node", "sub", "value"]),
      documentEdge("e1", ["node", "sub", "result"], ["workflow", "result"]),
    ],
  };
}

function fanOutDocument(child: GraphWorkflowDocument): GraphWorkflowDocument {
  return {
    id: "fanout-root",
    name: "fanout-root",
    inputs: [documentPort("value")],
    outputs: [documentPort("result")],
    nodes: [
      documentNode("fanout", "core.flow.executeSubWorkflow", {
        workflow: child,
        mode: "perItem",
      }),
    ],
    edges: [
      documentEdge("e0", ["workflow", "value"], ["node", "fanout", "value"]),
      documentEdge("e1", ["node", "fanout", "result"], ["workflow", "result"]),
    ],
  };
}

describe("sub-workflow execution budgets (C7)", () => {
  it("stops a self-referential saved workflow with GRAPH_SUB_WORKFLOW_DEPTH_EXCEEDED", async () => {
    const self = selfReferenceDocument();
    const catalogue = freshCatalogue();
    const engine = await bootEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
      workflowStore: savedStore({ [self.id]: self }),
      authEnabled: false,
      defaultOptions: { maxSubWorkflowDepth: 0 },
    });
    await registerBuiltInGraphNodes(catalogue);

    const result = await engine.execute(self, { value: 1 });

    expect(result.status).toBe("failed");
    expect(result.nodeResults.sub?.error).toMatchObject({
      code: "GRAPH_SUB_WORKFLOW_DEPTH_EXCEEDED",
    });
  });

  it("stops a perItem fan-out past maxChildRuns with GRAPH_SUB_WORKFLOW_CHILD_LIMIT_EXCEEDED", async () => {
    const child = delayChild();
    const catalogue = freshCatalogue();
    const engine = await bootEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
      workflowStore: savedStore({ [child.id]: child }),
      authEnabled: false,
      defaultOptions: { maxChildRuns: 1 },
    });
    await registerBuiltInGraphNodes(catalogue);

    const result = await engine.execute(fanOutDocument(child), {
      value: [1, 2, 3],
    });

    expect(result.status).toBe("failed");
    expect(result.nodeResults.fanout?.error).toMatchObject({
      code: "GRAPH_SUB_WORKFLOW_CHILD_LIMIT_EXCEEDED",
    });
  });

  it("does not charge loop iterations against the sub-workflow depth budget", async () => {
    const body: GraphWorkflowDocument = {
      id: "loop-body",
      name: "loop-body",
      inputs: [documentPort("item")],
      outputs: [documentPort("result")],
      nodes: [documentNode("echo", "core.flow.delay", {})],
      edges: [
        documentEdge("b0", ["workflow", "item"], ["node", "echo", "value"]),
        documentEdge("b1", ["node", "echo", "value"], ["workflow", "result"]),
      ],
    };
    const catalogue = freshCatalogue();
    const engine = await bootEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
      workflowStore: savedStore({ [body.id]: body }),
      authEnabled: false,
      defaultOptions: { maxSubWorkflowDepth: 0 },
    });
    await registerBuiltInGraphNodes(catalogue);

    const loopDocument: GraphWorkflowDocument = {
      id: "foreach-wf",
      name: "foreach-wf",
      inputs: [documentPort("in")],
      outputs: [documentPort("total")],
      nodes: [
        documentNode("loop1", "core.loop.foreach", {}, {
          loop: { body } as never,
        }),
      ],
      edges: [
        documentEdge("rin", ["workflow", "in"], ["node", "loop1", "items"]),
        documentEdge("rout", ["node", "loop1", "results"], ["workflow", "total"]),
      ],
    };

    const result = await engine.execute(loopDocument, { in: [1, 2, 3] });

    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.loop1?.outputs?.results).toEqual([1, 2, 3]);
    expect(result.outputs.total).toEqual([1, 2, 3]);
  });
});
