/**
 * @module as-graph/tests/unit/graph/nodes/WebhookTriggerNode.test
 * @summary Dedicated unit tests for the `core.trigger.webhook` node class's
 * instance `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.1, SAA-2015).
 */
import { WebhookTriggerNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("WebhookTriggerNode", () => {
  const manifest = graphNodeManifest(WebhookTriggerNode);

  describe("manifest", () => {
    it("publishes the core.trigger.webhook kind", () => {
      expect(manifest.kind).toBe("core.trigger.webhook");
    });

    it("declares the schema input and the payload output", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual(["schema"]);
      expect(manifest.outputs.map((port) => port.id)).toEqual(["payload"]);
    });

    it("renders the schema through the model builder and keeps payload plain", () => {
      const schema = manifest.inputs.find((port) => port.id === "schema");
      expect(schema?.element?.tag).toBe("ngx-decaf-model-builder");
      const payload = manifest.outputs.find((port) => port.id === "payload");
      expect(payload?.element).toBeUndefined();
    });
  });

  describe("execute", () => {
    it("forwards the received request payload", async () => {
      const context = buildNodeContext("core.trigger.webhook");
      const payload = { body: { id: 1 }, method: "POST" };
      const result = await executeNode(
        WebhookTriggerNode,
        nodeExecutionRequest({ payload }),
        context
      );
      expect(result).toEqual({ payload });
    });

    it("defaults a missing payload to null", async () => {
      const context = buildNodeContext("core.trigger.webhook");
      const result = await executeNode(
        WebhookTriggerNode,
        nodeExecutionRequest({}),
        context
      );
      expect(result).toEqual({ payload: null });
    });
  });
});
