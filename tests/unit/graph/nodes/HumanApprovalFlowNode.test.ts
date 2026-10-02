/**
 * @module as-graph/tests/unit/graph/nodes/HumanApprovalFlowNode.test
 * @summary Dedicated unit tests for the `core.flow.humanApproval` node class's
 * instance `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.2, SAA-2015).
 */
import { Metadata } from "@decaf-ts/decoration";
import { Model } from "@decaf-ts/decorator-validation";
import { HumanApprovalFlowNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

/** Reads the `@uielement` metadata for a property through the ui-decorators accessor. */
function uiElementOf(
  property: string
): { tag?: string; props?: Record<string, unknown> } | undefined {
  return (
    Model as unknown as {
      uiElementOf?: (
        model: unknown,
        prop: string
      ) => { tag?: string; props?: Record<string, unknown> } | undefined;
    }
  ).uiElementOf?.(HumanApprovalFlowNode, property);
}

describe("HumanApprovalFlowNode", () => {
  const manifest = graphNodeManifest(HumanApprovalFlowNode);

  describe("manifest", () => {
    it("publishes the core.flow.humanApproval kind", () => {
      expect(manifest.kind).toBe("core.flow.humanApproval");
    });

    it("declares the value/message/approved inputs and approved/rejected outputs", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual([
        "value",
        "message",
        "approved",
      ]);
      expect(manifest.outputs.map((port) => port.id)).toEqual([
        "approved",
        "rejected",
      ]);
    });

    it("declares message and approved as user-controllable uielement inputs", () => {
      const properties = Metadata.properties(HumanApprovalFlowNode) ?? [];
      expect(properties).toContain("message");
      expect(properties).toContain("approved");
      expect(manifest.inputs.map((port) => port.id)).toEqual(
        expect.arrayContaining(["message", "approved"])
      );
      const message = uiElementOf("message");
      expect(message?.tag).toBe("ngx-decaf-crud-field");
      expect(message?.props?.["type"]).toBe("textarea");
      const approved = uiElementOf("approved");
      expect(approved?.tag).toBe("ngx-decaf-crud-field");
      expect(approved?.props?.["type"]).toBe("checkbox");
    });
  });

  describe("execute", () => {
    it("routes the input to the approved port", async () => {
      const context = buildNodeContext("core.flow.humanApproval");
      const result = await executeNode(
        HumanApprovalFlowNode,
        nodeExecutionRequest({ value: { request: "approve me" } }),
        context
      );
      expect(result).toEqual({ approved: { request: "approve me" } });
    });

    it("falls back to the full input map when no value port is routed", async () => {
      const context = buildNodeContext("core.flow.humanApproval");
      const result = await executeNode(
        HumanApprovalFlowNode,
        nodeExecutionRequest({ ticket: 1 }),
        context
      );
      expect(result).toEqual({ approved: { ticket: 1 } });
    });

    it("preserves a falsy routed value (nullish fallback only)", async () => {
      const context = buildNodeContext("core.flow.humanApproval");
      const result = await executeNode(
        HumanApprovalFlowNode,
        nodeExecutionRequest({ value: false }),
        context
      );
      expect(result).toEqual({ approved: false });
    });

    it("routes to the rejected port when the approved parameter is false", async () => {
      const context = buildNodeContext("core.flow.humanApproval", {
        parameters: { approved: false },
      });
      const result = await executeNode(
        HumanApprovalFlowNode,
        nodeExecutionRequest({ value: { request: "reject me" } }),
        context
      );
      expect(result).toEqual({ rejected: { request: "reject me" } });
    });
  });
});
