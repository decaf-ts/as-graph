/**
 * @module as-graph/tests/unit/graph/nodes/EventTriggerNode.test
 * @summary Dedicated unit tests for the `core.trigger.event` node class's
 * instance `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.1, SAA-2015).
 */
import { EventTriggerNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("EventTriggerNode", () => {
  const manifest = graphNodeManifest(EventTriggerNode);

  describe("manifest", () => {
    it("publishes the core.trigger.event kind", () => {
      expect(manifest.kind).toBe("core.trigger.event");
    });

    it("declares no inputs and the payload output", () => {
      expect(manifest.inputs).toEqual([]);
      expect(manifest.outputs.map((port) => port.id)).toEqual(["payload"]);
    });

    it("declares no user-controllable @uielement parameters", () => {
      expect(manifest.parameters).toEqual([]);
    });
  });

  describe("execute", () => {
    it("forwards the event payload", async () => {
      const context = buildNodeContext("core.trigger.event");
      const payload = { topic: "orders", value: 7 };
      const result = await executeNode(
        EventTriggerNode,
        nodeExecutionRequest({ payload }),
        context
      );
      expect(result).toEqual({ payload });
    });

    it("defaults a missing payload to null", async () => {
      const context = buildNodeContext("core.trigger.event");
      const result = await executeNode(
        EventTriggerNode,
        nodeExecutionRequest({}),
        context
      );
      expect(result).toEqual({ payload: null });
    });

    it("preserves a falsy payload (nullish fallback only)", async () => {
      const context = buildNodeContext("core.trigger.event");
      const result = await executeNode(
        EventTriggerNode,
        nodeExecutionRequest({ payload: 0 }),
        context
      );
      expect(result).toEqual({ payload: 0 });
    });
  });
});
