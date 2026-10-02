/**
 * @module as-graph/tests/unit/graph/nodes/LogFlowNode.test
 * @summary Dedicated unit tests for the `core.flow.log` node class's instance
 * `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.2, SAA-2015).
 */
import { LogFlowNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("LogFlowNode", () => {
  const manifest = graphNodeManifest(LogFlowNode);

  describe("manifest", () => {
    it("publishes the core.flow.log kind", () => {
      expect(manifest.kind).toBe("core.flow.log");
    });

    it("declares value/message/level inputs and the value output", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual([
        "value",
        "message",
        "level",
      ]);
      expect(manifest.outputs.map((port) => port.id)).toEqual(["value"]);
    });

    it("keeps the value port plain and renders message through the crud field", () => {
      const value = manifest.inputs.find((port) => port.id === "value");
      expect(value?.element).toBeUndefined();
      const message = manifest.inputs.find((port) => port.id === "message");
      expect(message?.element?.tag).toBe("ngx-decaf-crud-field");
    });

    it("declares no logged output port", () => {
      expect(manifest.outputs.map((port) => port.id)).not.toContain("logged");
    });
  });

  describe("execute", () => {
    it("logs the routed value at the default info level and forwards it", async () => {
      const context = buildNodeContext("core.flow.log");
      const info = jest.spyOn(context.logger, "info");
      try {
        const result = await executeNode(
          LogFlowNode,
          nodeExecutionRequest({ value: "hello" }),
          context
        );
        expect(info).toHaveBeenCalledWith("Log node", { value: "hello" });
        expect(result).toEqual({ value: "hello" });
      } finally {
        info.mockRestore();
      }
    });

    it("reads the user-controllable level and message from this.*", async () => {
      const context = buildNodeContext("core.flow.log", {
        parameters: { level: "warn", message: "custom message" },
      });
      const warn = jest.spyOn(context.logger, "warn");
      try {
        const result = await executeNode(
          LogFlowNode,
          nodeExecutionRequest({ value: 7 }),
          context
        );
        expect(warn).toHaveBeenCalledWith("custom message", { value: 7 });
        expect(result).toEqual({ value: 7 });
      } finally {
        warn.mockRestore();
      }
    });

    it("forwards an undefined value unchanged", async () => {
      const context = buildNodeContext("core.flow.log");
      const info = jest.spyOn(context.logger, "info");
      try {
        const result = await executeNode(
          LogFlowNode,
          nodeExecutionRequest({}),
          context
        );
        expect(info).toHaveBeenCalledWith("Log node", { value: undefined });
        expect(result).toEqual({ value: undefined });
      } finally {
        info.mockRestore();
      }
    });
  });
});
