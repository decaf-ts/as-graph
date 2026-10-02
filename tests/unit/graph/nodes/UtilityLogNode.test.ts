/**
 * @module as-graph/tests/unit/graph/nodes/UtilityLogNode.test
 * @summary Dedicated unit tests for the `core.utility.log` node class's instance
 * `execute` (DECAF-50 §4.26 R2-1, DECAF-48 §4.3, SAA-2015).
 */
import { UtilityLogNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("UtilityLogNode", () => {
  const manifest = graphNodeManifest(UtilityLogNode);

  describe("manifest", () => {
    it("publishes the core.utility.log kind", () => {
      expect(manifest.kind).toBe("core.utility.log");
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
      const context = buildNodeContext("core.utility.log");
      const info = jest.spyOn(context.logger, "info");
      try {
        const result = await executeNode(
          UtilityLogNode,
          nodeExecutionRequest({ value: "observed" }),
          context
        );
        expect(info).toHaveBeenCalledWith("Log node", { value: "observed" });
        expect(result).toEqual({ value: "observed" });
      } finally {
        info.mockRestore();
      }
    });

    it("reads the user-controllable level and message from this.*", async () => {
      const context = buildNodeContext("core.utility.log", {
        parameters: { level: "error", message: "boom" },
      });
      const error = jest.spyOn(context.logger, "error");
      try {
        const result = await executeNode(
          UtilityLogNode,
          nodeExecutionRequest({ value: "x" }),
          context
        );
        expect(error).toHaveBeenCalledWith("boom", { value: "x" });
        expect(result).toEqual({ value: "x" });
      } finally {
        error.mockRestore();
      }
    });

    it("forwards a falsy value unchanged (no coercion)", async () => {
      const context = buildNodeContext("core.utility.log");
      const info = jest.spyOn(context.logger, "info");
      try {
        const result = await executeNode(
          UtilityLogNode,
          nodeExecutionRequest({ value: 0 }),
          context
        );
        expect(info).toHaveBeenCalledWith("Log node", { value: 0 });
        expect(result).toEqual({ value: 0 });
      } finally {
        info.mockRestore();
      }
    });
  });
});
