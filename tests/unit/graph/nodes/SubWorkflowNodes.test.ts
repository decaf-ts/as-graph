/**
 * @module as-graph/tests/unit/graph/nodes/SubWorkflowNodes.test
 * @summary Unit coverage for the SAA-746 Stage 1 sub-workflow nodes.
 * @description Drives `core.flow.executeSubWorkflow` and
 * `core.trigger.executeWorkflow` against a recording engine facade: inline and
 * `workflowId` child resolution through `engine.getWorkflow`, parent run-id
 * propagation, `mode: "perItem"` aggregation, and the documented failure codes.
 */
import { describe, it, expect } from "@jest/globals";

import { ExecuteSubWorkflowNode } from "../../../../src/node/flow/execute-sub-workflow/node";
import { ExecuteWorkflowTriggerNode } from "../../../../src/node/triggers/execute-workflow/node";
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import type { GraphExecutionEngine } from "../../../../src/engine/execution/GraphExecutionEngine";
import type { GraphExecutionValues } from "../../../../src/engine/types";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

interface ExecuteCall {
  document: GraphWorkflowDocument;
  inputs: Record<string, unknown>;
  options: Record<string, unknown>;
}

const CHILD: GraphWorkflowDocument = {
  id: "child-wf",
  name: "child-wf",
  nodes: [],
  edges: [],
};

function recordingEngine(
  behaviour: (
    call: ExecuteCall
  ) => GraphExecutionValues = (call) => ({
    result: Object.values(call.inputs)[0],
  })
): {
  engine: GraphExecutionEngine;
  executeCalls: ExecuteCall[];
  getWorkflowCalls: string[];
} {
  const executeCalls: ExecuteCall[] = [];
  const getWorkflowCalls: string[] = [];
  const engine = {
    getWorkflow: async (workflowId: string) => {
      getWorkflowCalls.push(workflowId);
      return CHILD;
    },
    execute: async (
      document: GraphWorkflowDocument,
      inputs: Record<string, unknown>,
      options: Record<string, unknown>
    ) => {
      const call = { document, inputs, options };
      executeCalls.push(call);
      return {
        runId: `child-run-${executeCalls.length}`,
        outputs: behaviour(call),
      };
    },
  } as unknown as GraphExecutionEngine;
  return { engine, executeCalls, getWorkflowCalls };
}

function asEngine(value: unknown): GraphExecutionEngine {
  return value as GraphExecutionEngine;
}

describe("core.flow.executeSubWorkflow", () => {
  const kind = "core.flow.executeSubWorkflow";

  it("executes an inline child document and propagates the parent run id", async () => {
    const { engine, executeCalls } = recordingEngine();
    const context = buildNodeContext(kind, {
      parameters: { workflow: CHILD, inputPort: "payload" },
      engine,
    });
    const result = await executeNode(
      ExecuteSubWorkflowNode,
      nodeExecutionRequest({ value: { id: 7 } }),
      context
    );

    expect(result).toEqual({
      result: { id: 7 },
      outputs: { result: { id: 7 } },
      childRunId: "child-run-1",
    });
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0].document).toBe(CHILD);
    expect(executeCalls[0].inputs).toEqual({ payload: { id: 7 } });
    expect(executeCalls[0].options).toMatchObject({
      parentRunId: "run-1",
      path: [kind, "subworkflow"],
    });
  });

  it("resolves a child document by workflowId through engine.getWorkflow", async () => {
    const { engine, executeCalls, getWorkflowCalls } = recordingEngine();
    const context = buildNodeContext(kind, {
      parameters: { workflowId: "child-wf" },
      engine,
    });
    const result = await executeNode(
      ExecuteSubWorkflowNode,
      nodeExecutionRequest({ value: 1 }),
      context
    );

    expect(getWorkflowCalls).toEqual(["child-wf"]);
    expect(executeCalls[0].document).toBe(CHILD);
    expect(executeCalls[0].inputs).toEqual({ value: 1 });
    expect(result.childRunId).toBe("child-run-1");
  });

  it("aggregates perItem children in input order", async () => {
    const { engine, executeCalls } = recordingEngine((call) => ({
      result: Number(call.inputs["value"]) * 10,
    }));
    const context = buildNodeContext(kind, {
      parameters: { workflow: CHILD, mode: "perItem" },
      engine,
    });
    const result = await executeNode(
      ExecuteSubWorkflowNode,
      nodeExecutionRequest({ value: [1, 2, 3] }),
      context
    );

    expect(executeCalls).toHaveLength(3);
    expect(result).toEqual({
      result: [10, 20, 30],
      outputs: { result: 30 },
      childRunId: "child-run-3",
    });
    for (const call of executeCalls) {
      expect(call.options).toMatchObject({ parentRunId: "run-1" });
    }
  });

  it("returns an empty aggregation for nil input in perItem mode (R7)", async () => {
    const { engine, executeCalls } = recordingEngine();
    const context = buildNodeContext(kind, {
      parameters: { workflow: CHILD, mode: "perItem" },
      engine,
    });
    const result = await executeNode(
      ExecuteSubWorkflowNode,
      nodeExecutionRequest({}),
      context
    );

    expect(executeCalls).toHaveLength(0);
    expect(result).toEqual({
      result: [],
      outputs: undefined,
      childRunId: undefined,
    });
  });

  it("falls back to the `input` port and reports the child's whole output map", async () => {
    const { engine, executeCalls } = recordingEngine(() => ({ other: true }));
    const context = buildNodeContext(kind, { parameters: { workflow: CHILD }, engine });
    const result = await executeNode(
      ExecuteSubWorkflowNode,
      nodeExecutionRequest({ input: "legacy" }),
      context
    );

    expect(executeCalls[0].inputs).toEqual({ value: "legacy" });
    expect(result.result).toEqual({ other: true });
  });

  it("fails closed without engine access or a child document", async () => {
    await expect(
      executeNode(
        ExecuteSubWorkflowNode,
        nodeExecutionRequest({ value: 1 }),
        buildNodeContext(kind, { parameters: { workflow: CHILD } })
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_ENGINE_NOT_AVAILABLE" });

    await expect(
      executeNode(
        ExecuteSubWorkflowNode,
        nodeExecutionRequest({ value: 1 }),
        buildNodeContext(kind, { parameters: {}, engine: asEngine({}) })
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_SUB_WORKFLOW_REQUIRED" });
  });

  it("maps an unresolved workflowId to GRAPH_SUB_WORKFLOW_NOT_FOUND", async () => {
    const engine = {
      getWorkflow: async () => {
        throw new Error("missing");
      },
      execute: async () => ({ outputs: {} }),
    } as unknown as GraphExecutionEngine;
    await expect(
      executeNode(
        ExecuteSubWorkflowNode,
        nodeExecutionRequest({ value: 1 }),
        buildNodeContext(kind, { parameters: { workflowId: "nope" }, engine })
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_SUB_WORKFLOW_NOT_FOUND" });
  });
});

describe("core.trigger.executeWorkflow", () => {
  const kind = "core.trigger.executeWorkflow";

  async function run(
    inputs: Record<string, unknown>
  ): Promise<GraphExecutionValues> {
    return await executeNode(
      ExecuteWorkflowTriggerNode,
      nodeExecutionRequest(inputs),
      buildNodeContext(kind, {})
    );
  }

  it("passes the payload through unchanged", async () => {
    expect(await run({ payload: { orderId: 42 } })).toEqual({
      result: { orderId: 42 },
    });
  });

  it("falls back to value and then to the whole input map", async () => {
    expect(await run({ value: "fallback" })).toEqual({ result: "fallback" });
    expect(await run({ a: 1, b: 2 })).toEqual({ result: { a: 1, b: 2 } });
  });

  it("keeps a falsy payload instead of falling back", async () => {
    expect(await run({ payload: 0, value: "ignored" })).toEqual({ result: 0 });
    expect(await run({ payload: null, value: "ignored" })).toEqual({ result: null });
  });

  it("returns an empty object for nil input (R7)", async () => {
    expect(await run({})).toEqual({ result: {} });
  });
});
