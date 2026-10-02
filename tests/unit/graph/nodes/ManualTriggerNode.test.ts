/**
 * @module as-graph/tests/unit/graph/nodes/ManualTriggerNode.test
 * @summary Dedicated unit tests for the `core.trigger.manual` node class's
 * instance `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.1, SAA-2015).
 */
import { ManualTriggerNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("ManualTriggerNode", () => {
  const manifest = graphNodeManifest(ManualTriggerNode);

  describe("manifest", () => {
    it("publishes the core.trigger.manual kind", () => {
      expect(manifest.kind).toBe("core.trigger.manual");
    });

    it("is payloadless: no inputs and a plain payload output", () => {
      expect(manifest.inputs).toEqual([]);
      expect(manifest.outputs.map((port) => port.id)).toEqual(["payload"]);
      const payload = manifest.outputs.find((port) => port.id === "payload");
      expect(payload?.element).toBeUndefined();
    });

    it("declares no user-controllable parameters", () => {
      expect(manifest.parameters).toEqual([]);
    });
  });

  describe("execute", () => {
    it("forwards the runtime run payload", async () => {
      const context = buildNodeContext("core.trigger.manual");
      const payload = { startedBy: "user-1" };
      const result = await executeNode(
        ManualTriggerNode,
        nodeExecutionRequest({ payload }),
        context
      );
      expect(result).toEqual({ payload });
    });

    it("defaults a missing payload to null", async () => {
      const context = buildNodeContext("core.trigger.manual");
      const result = await executeNode(
        ManualTriggerNode,
        nodeExecutionRequest({}),
        context
      );
      expect(result).toEqual({ payload: null });
    });
  });
});
