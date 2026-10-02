/**
 * @module as-graph/tests/unit/graph/nodes/GraphInputValueNode.test
 * @summary Dedicated unit tests for the `value` workflow input boundary node
 * class's instance `execute` (DECAF-50 §4.26 R2-1, SAA-2015).
 */
import { GraphInputValueNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("GraphInputValueNode", () => {
  const manifest = graphNodeManifest(GraphInputValueNode);

  describe("manifest", () => {
    it("publishes the value boundary kind", () => {
      expect(manifest.kind).toBe("value");
    });

    it("declares no inputs and the value output", () => {
      expect(manifest.inputs).toEqual([]);
      expect(manifest.outputs.map((port) => port.id)).toEqual(["value"]);
    });

    it("allows the value output to feed multiple targets", () => {
      const value = manifest.outputs.find((port) => port.id === "value");
      expect(value?.connectionPolicy?.allowMultiple).toBe(true);
    });

    it("declares no user-controllable parameters", () => {
      expect(manifest.parameters).toEqual([]);
    });
  });

  describe("execute", () => {
    it("forwards the routed boundary value on the value port", async () => {
      const context = buildNodeContext("value");
      const result = await executeNode(
        GraphInputValueNode,
        nodeExecutionRequest({ value: "wf-input" }),
        context
      );
      expect(result).toEqual({ value: "wf-input" });
    });

    it("defaults a missing boundary value to null", async () => {
      const context = buildNodeContext("value");
      const result = await executeNode(
        GraphInputValueNode,
        nodeExecutionRequest({}),
        context
      );
      expect(result).toEqual({ value: null });
    });

    it("preserves a falsy boundary value (nullish fallback only)", async () => {
      const context = buildNodeContext("value");
      const result = await executeNode(
        GraphInputValueNode,
        nodeExecutionRequest({ value: 0 }),
        context
      );
      expect(result).toEqual({ value: 0 });
    });
  });
});
