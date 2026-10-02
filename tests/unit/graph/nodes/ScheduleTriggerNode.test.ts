/**
 * @module as-graph/tests/unit/graph/nodes/ScheduleTriggerNode.test
 * @summary Dedicated unit tests for the `core.trigger.schedule` node class's
 * instance `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.1, SAA-2015).
 */
import { ScheduleTriggerNode } from "../../../../src/node";
import { graphNodeConfig } from "../../../../src/node/base";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("ScheduleTriggerNode", () => {
  const manifest = graphNodeManifest(ScheduleTriggerNode);

  describe("manifest", () => {
    it("publishes the core.trigger.schedule kind", () => {
      expect(manifest.kind).toBe("core.trigger.schedule");
    });

    it("declares the cron input and the payload output", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual(["cron"]);
      expect(manifest.outputs.map((port) => port.id)).toEqual(["payload"]);
    });

    it("renders the cron input through the cron selector field", () => {
      const cron = manifest.inputs.find((port) => port.id === "cron");
      expect(cron?.element?.tag).toBe("app-cron-selector-field");
    });
  });

  describe("execute", () => {
    it("forwards the scheduled run payload", async () => {
      const context = buildNodeContext("core.trigger.schedule", {
        parameters: { cron: "0 * * * *" },
      });
      const payload = { firedAt: "2026-01-01T00:00:00Z" };
      const result = await executeNode(
        ScheduleTriggerNode,
        nodeExecutionRequest({ payload }),
        context
      );
      expect(result).toEqual({ payload });
    });

    it("defaults a missing payload to null", async () => {
      const context = buildNodeContext("core.trigger.schedule", {
        parameters: { cron: "0 * * * *" },
      });
      const result = await executeNode(
        ScheduleTriggerNode,
        nodeExecutionRequest({}),
        context
      );
      expect(result).toEqual({ payload: null });
    });

    it("reads the user-controllable cron from this.* (hydrated from parameters)", () => {
      const context = buildNodeContext("core.trigger.schedule", {
        parameters: { cron: "*/5 * * * *" },
      });
      const instance = ScheduleTriggerNode.instantiate(
        graphNodeConfig(context.node)
      );
      expect((instance as unknown as { cron?: string }).cron).toBe(
        "*/5 * * * *"
      );
    });
  });
});
