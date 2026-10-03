/**
 * @module as-graph/tests/unit/graph/nodes/IfFlowNode.test
 * @summary Dedicated unit tests for the `core.flow.if` node class's instance
 * `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.2, SAA-2015).
 */
import { IfFlowNode } from "../../../../src/node";
import { graphNodeConfig } from "../../../../src/node/base";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import type { CodeSandboxEvaluator } from "../../../../src/engine/execution/CodeSandboxEvaluator";
import type { GraphExecutionEngine } from "../../../../src/engine/execution/GraphExecutionEngine";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest, bootCodeSandboxEvaluator } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

/** Engine facade exposing only the `codeSandboxEvaluator` the if node reads. */
function engineWith(
  codeSandboxEvaluator?: CodeSandboxEvaluator
): GraphExecutionEngine {
  return { codeSandboxEvaluator } as unknown as GraphExecutionEngine;
}

describe("IfFlowNode", () => {
  const manifest = graphNodeManifest(IfFlowNode);

  describe("manifest", () => {
    it("publishes the core.flow.if kind", () => {
      expect(manifest.kind).toBe("core.flow.if");
    });

    it("declares value/condition/else inputs and the then output", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual([
        "value",
        "condition",
        "else",
      ]);
      expect(manifest.outputs.map((port) => port.id)).toEqual(["then"]);
    });

    it("renders the condition through the code editor and else through a checkbox", () => {
      const condition = manifest.inputs.find((port) => port.id === "condition");
      expect(condition?.element?.props?.["type"]).toBe("code");
      const elsePort = manifest.inputs.find((port) => port.id === "else");
      expect(elsePort?.element?.props?.["type"]).toBe("checkbox");
    });
  });

  describe("execute", () => {
    it("routes the value to then when the condition matches", async () => {
      const context = buildNodeContext("core.flow.if", {
        parameters: {
          condition: { op: "eq", left: { const: true }, right: { const: true } },
        },
      });
      const result = await executeNode(
        IfFlowNode,
        nodeExecutionRequest({ value: "x" }),
        context
      );
      expect(result).toEqual({ then: "x" });
    });

    it("routes the value to else when the condition fails and else is enabled", async () => {
      const context = buildNodeContext("core.flow.if", {
        parameters: {
          condition: { op: "eq", left: { const: true }, right: { const: false } },
          else: true,
        },
      });
      const result = await executeNode(
        IfFlowNode,
        nodeExecutionRequest({ value: "x" }),
        context
      );
      expect(result).toEqual({ else: "x" });
    });

    it("reads the user-controllable condition from this.* (hydrated from parameters)", async () => {
      const context = buildNodeContext("core.flow.if", {
        parameters: {
          condition: { op: "eq", left: { const: 1 }, right: { const: 1 } },
        },
      });
      const instance = IfFlowNode.instantiate(graphNodeConfig(context.node));
      expect(
        (instance as unknown as { condition?: unknown }).condition
      ).toEqual({
        op: "eq",
        left: { const: 1 },
        right: { const: 1 },
      });
      expect(
        (instance as unknown as { else?: boolean }).else
      ).toBeUndefined();
    });

    it("merges the full input map so a path can reference any input port", async () => {
      const context = buildNodeContext("core.flow.if", {
        parameters: {
          condition: {
            op: "eq",
            left: { path: "other" },
            right: { const: 9 },
          },
        },
      });
      const result = await executeNode(
        IfFlowNode,
        nodeExecutionRequest({ value: { n: 2 }, other: 9 }),
        context
      );
      expect(result).toEqual({ then: { n: 2 } });
    });

    it("throws GRAPH_IF_NO_CONDITION when no condition is configured", () => {
      const context = buildNodeContext("core.flow.if");
      let error: unknown;
      try {
        executeNode(IfFlowNode, nodeExecutionRequest({ value: "x" }), context);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GraphExecutionError);
      expect((error as GraphExecutionError).graphCode).toBe(
        "GRAPH_IF_NO_CONDITION"
      );
    });

    it("throws GRAPH_IF_ELSE_DISABLED when the condition is false and else is disabled", () => {
      const context = buildNodeContext("core.flow.if", {
        parameters: {
          condition: { op: "eq", left: { const: true }, right: { const: false } },
        },
      });
      let error: unknown;
      try {
        executeNode(IfFlowNode, nodeExecutionRequest({ value: "x" }), context);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GraphExecutionError);
      expect((error as GraphExecutionError).graphCode).toBe(
        "GRAPH_IF_ELSE_DISABLED"
      );
    });
  });

  describe("CodeCondition (code mode, SAA-66)", () => {
    let evaluator: Awaited<ReturnType<typeof bootCodeSandboxEvaluator>>;

    beforeAll(async () => {
      evaluator = await bootCodeSandboxEvaluator();
    });

    it("routes to then when the code condition is truthy", async () => {
      const context = buildNodeContext("core.flow.if", {
        parameters: {
          condition: { type: "code", code: "return $input.value === 'yes';" },
        },
        engine: engineWith(evaluator),
      });
      const result = await executeNode(
        IfFlowNode,
        nodeExecutionRequest({ value: "yes" }),
        context
      );
      expect(result).toEqual({ then: "yes" });
    });

    it("routes to else when the code condition is falsy and else is enabled", async () => {
      const context = buildNodeContext("core.flow.if", {
        parameters: {
          condition: { type: "code", code: "return $input.value === 'yes';" },
          else: true,
        },
        engine: engineWith(evaluator),
      });
      const result = await executeNode(
        IfFlowNode,
        nodeExecutionRequest({ value: "no" }),
        context
      );
      expect(result).toEqual({ else: "no" });
    });

    it("throws GRAPH_IF_ELSE_DISABLED when the code condition is falsy and else is disabled", async () => {
      const context = buildNodeContext("core.flow.if", {
        parameters: {
          condition: { type: "code", code: "return $input.value === 'yes';" },
        },
        engine: engineWith(evaluator),
      });
      await expect(
        executeNode(IfFlowNode, nodeExecutionRequest({ value: "no" }), context)
      ).rejects.toMatchObject({ graphCode: "GRAPH_IF_ELSE_DISABLED" });
    });

    it("throws GRAPH_CODE_SANDBOX_NOT_CONFIGURED without a registered evaluator", async () => {
      const context = buildNodeContext("core.flow.if", {
        parameters: {
          condition: { type: "code", code: "return true;" },
        },
      });
      await expect(
        executeNode(IfFlowNode, nodeExecutionRequest({ value: "x" }), context)
      ).rejects.toMatchObject({
        graphCode: "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
      });
    });
  });

  describe("graphical regression (SAA-66)", () => {
    it("keeps the synchronous throw contract for a missing condition", () => {
      const context = buildNodeContext("core.flow.if");
      expect(() =>
        executeNode(IfFlowNode, nodeExecutionRequest({ value: "x" }), context)
      ).toThrow(GraphExecutionError);
    });

    it("keeps the synchronous throw contract for a disabled else", () => {
      const context = buildNodeContext("core.flow.if", {
        parameters: {
          condition: { op: "eq", left: { const: true }, right: { const: false } },
        },
      });
      expect(() =>
        executeNode(IfFlowNode, nodeExecutionRequest({ value: "x" }), context)
      ).toThrow(GraphExecutionError);
    });
  });
});
