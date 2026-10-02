/**
 * @module as-graph/tests/unit/graph/nodes/ErrorBoundaryFlowNode.test
 * @summary Dedicated unit tests for the `core.flow.errorBoundary` node class's
 * instance `execute` (DECAF-50 §4.26 R2-1, SAA-2015).
 */
import { ErrorBoundaryFlowNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("ErrorBoundaryFlowNode", () => {
  const manifest = graphNodeManifest(ErrorBoundaryFlowNode);

  describe("manifest", () => {
    it("publishes the core.flow.errorBoundary kind", () => {
      expect(manifest.kind).toBe("core.flow.errorBoundary");
    });

    it("declares a single value input and result/error outputs", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual(["value"]);
      expect(manifest.outputs.map((port) => port.id)).toEqual([
        "result",
        "error",
      ]);
    });

    it("renders the value input through the crud field textarea", () => {
      const value = manifest.inputs.find((port) => port.id === "value");
      expect(value?.element?.tag).toBe("ngx-decaf-crud-field");
      expect(value?.element?.props?.["type"]).toBe("textarea");
    });
  });

  describe("execute", () => {
    it("passes the routed value through on the result port", async () => {
      const context = buildNodeContext("core.flow.errorBoundary");
      const result = await executeNode(
        ErrorBoundaryFlowNode,
        nodeExecutionRequest({ value: "payload" }),
        context
      );
      expect(result).toEqual({ result: "payload" });
    });

    it("falls back to the full input map when no value port is routed", async () => {
      const context = buildNodeContext("core.flow.errorBoundary");
      const result = await executeNode(
        ErrorBoundaryFlowNode,
        nodeExecutionRequest({ other: 1, nested: { a: 2 } }),
        context
      );
      expect(result).toEqual({ result: { other: 1, nested: { a: 2 } } });
    });

    it("passes a falsy routed value through unchanged (nullish fallback only)", async () => {
      const context = buildNodeContext("core.flow.errorBoundary");
      const result = await executeNode(
        ErrorBoundaryFlowNode,
        nodeExecutionRequest({ value: 0 }),
        context
      );
      expect(result).toEqual({ result: 0 });
    });
  });
});
