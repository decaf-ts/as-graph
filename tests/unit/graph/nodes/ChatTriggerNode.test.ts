/**
 * @module as-graph/tests/unit/graph/nodes/ChatTriggerNode.test
 * @summary Dedicated unit tests for the `core.trigger.chat` node class's
 * instance `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.1, SAA-2015).
 */
import { ChatTriggerNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("ChatTriggerNode", () => {
  const manifest = graphNodeManifest(ChatTriggerNode);

  describe("manifest", () => {
    it("publishes the core.trigger.chat kind", () => {
      expect(manifest.kind).toBe("core.trigger.chat");
    });

    it("declares no inputs and the message/sessionId/userId outputs", () => {
      expect(manifest.inputs).toEqual([]);
      expect(manifest.outputs.map((port) => port.id)).toEqual([
        "message",
        "sessionId",
        "userId",
      ]);
    });

    it("declares no user-controllable @uielement parameters", () => {
      expect(manifest.parameters).toEqual([]);
    });
  });

  describe("execute", () => {
    it("forwards the chat payload on message/sessionId/userId", async () => {
      const context = buildNodeContext("core.trigger.chat");
      const result = await executeNode(
        ChatTriggerNode,
        nodeExecutionRequest({
          message: "hello",
          sessionId: "s-1",
          userId: "u-1",
        }),
        context
      );
      expect(result).toEqual({
        message: "hello",
        sessionId: "s-1",
        userId: "u-1",
      });
    });

    it("defaults missing payload fields to null", async () => {
      const context = buildNodeContext("core.trigger.chat");
      const result = await executeNode(
        ChatTriggerNode,
        nodeExecutionRequest({ message: "only message" }),
        context
      );
      expect(result).toEqual({
        message: "only message",
        sessionId: null,
        userId: null,
      });
    });

    it("returns an all-null payload shape when no fields are routed", async () => {
      const context = buildNodeContext("core.trigger.chat");
      const result = await executeNode(
        ChatTriggerNode,
        nodeExecutionRequest({}),
        context
      );
      expect(result).toEqual({ message: null, sessionId: null, userId: null });
    });
  });
});
