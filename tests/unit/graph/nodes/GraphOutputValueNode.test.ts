/**
 * @module as-graph/tests/unit/graph/nodes/GraphOutputValueNode.test
 * @summary Dedicated unit tests for the `result` workflow output boundary node
 * class's instance `execute` (DECAF-50 §4.26 R2-1, SAA-2015).
 */
import { GraphOutputValueNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("GraphOutputValueNode", () => {
  const manifest = graphNodeManifest(GraphOutputValueNode);

  describe("manifest", () => {
    it("publishes the result boundary kind", () => {
      expect(manifest.kind).toBe("result");
    });

    it("declares the value input and no outputs", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual(["value"]);
      expect(manifest.outputs).toEqual([]);
    });

    it("declares the value parameter derived from the value input", () => {
      expect(manifest.parameters.map((parameter) => parameter.id)).toEqual([
        "value",
      ]);
    });
  });

  describe("execute", () => {
    it("is a void sink that produces no output values", async () => {
      const context = buildNodeContext("result");
      const result = await executeNode(
        GraphOutputValueNode,
        nodeExecutionRequest({ value: 42 }),
        context
      );
      expect(result).toEqual({});
    });

    it("still produces no output values when the value input is missing", async () => {
      const context = buildNodeContext("result");
      const result = await executeNode(
        GraphOutputValueNode,
        nodeExecutionRequest({}),
        context
      );
      expect(result).toEqual({});
    });
  });
});
