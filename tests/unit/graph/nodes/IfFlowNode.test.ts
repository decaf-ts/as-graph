/**
 * @module as-graph/tests/unit/graph/nodes/IfFlowNode.test
 * @summary Dedicated unit tests for the `core.flow.if` node class's instance
 * `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.2, SAA-2015).
 */
import { IfFlowNode } from "../../../../src/node";
import { graphNodeConfig } from "../../../../src/node/base";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

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
});
