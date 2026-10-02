/**
 * @module as-graph/tests/unit/graph/nodes/DelayFlowNode.test
 * @summary Dedicated unit tests for the `core.flow.delay` node class's instance
 * `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.2, SAA-2015).
 */
import { DelayFlowNode } from "../../../../src/node";
import { graphNodeConfig } from "../../../../src/node/base";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("DelayFlowNode", () => {
  const manifest = graphNodeManifest(DelayFlowNode);

  describe("manifest", () => {
    it("publishes the core.flow.delay kind", () => {
      expect(manifest.kind).toBe("core.flow.delay");
    });

    it("declares value and timeoutMs inputs and the value output", () => {
      expect(manifest.inputs.map((port) => port.id).sort()).toEqual([
        "timeoutMs",
        "value",
      ]);
      expect(manifest.outputs.map((port) => port.id)).toEqual(["value"]);
    });

    it("renders timeoutMs through the crud field number input", () => {
      const timeout = manifest.inputs.find((port) => port.id === "timeoutMs");
      expect(timeout?.element?.tag).toBe("ngx-decaf-crud-field");
      expect(timeout?.element?.props?.["type"]).toBe("number");
    });
  });

  describe("execute", () => {
    it("forwards the routed value unchanged (passthrough)", async () => {
      const context = buildNodeContext("core.flow.delay", {
        parameters: { timeoutMs: 10 },
      });
      const result = await executeNode(
        DelayFlowNode,
        nodeExecutionRequest({ value: "payload" }),
        context
      );
      expect(result).toEqual({ value: "payload" });
    });

    it("falls back to the full input map when no value port is routed", async () => {
      const context = buildNodeContext("core.flow.delay");
      const result = await executeNode(
        DelayFlowNode,
        nodeExecutionRequest({ other: 1 }),
        context
      );
      expect(result).toEqual({ value: { other: 1 } });
    });

    it("reads the user-controllable timeoutMs from this.* (hydrated from parameters)", () => {
      const context = buildNodeContext("core.flow.delay", {
        parameters: { timeoutMs: 250 },
      });
      const instance = DelayFlowNode.instantiate(graphNodeConfig(context.node));
      expect(
        (instance as unknown as { timeoutMs?: number }).timeoutMs
      ).toBe(250);
    });
  });
});
