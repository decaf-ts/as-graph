/**
 * @module as-graph/tests/unit/graph/nodes/FormTriggerNode.test
 * @summary Dedicated unit tests for the `core.trigger.form` node class's
 * instance `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.1, SAA-2015).
 */
import { FormTriggerNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("FormTriggerNode", () => {
  const manifest = graphNodeManifest(FormTriggerNode);

  describe("manifest", () => {
    it("publishes the core.trigger.form kind", () => {
      expect(manifest.kind).toBe("core.trigger.form");
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
    it("forwards the submitted form payload", async () => {
      const context = buildNodeContext("core.trigger.form");
      const payload = { name: "Ada", age: 36 };
      const result = await executeNode(
        FormTriggerNode,
        nodeExecutionRequest({ payload }),
        context
      );
      expect(result).toEqual({ payload });
    });

    it("defaults a missing payload to null", async () => {
      const context = buildNodeContext("core.trigger.form");
      const result = await executeNode(
        FormTriggerNode,
        nodeExecutionRequest({}),
        context
      );
      expect(result).toEqual({ payload: null });
    });
  });
});
