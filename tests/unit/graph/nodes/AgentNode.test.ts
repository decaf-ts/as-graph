/**
 * @module as-graph/tests/unit/graph/nodes/AgentNode.test
 * @summary Dedicated unit tests for the `core.agent` node class's instance
 * `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §21.3, SAA-2015).
 */
import { AgentNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("AgentNode", () => {
  const manifest = graphNodeManifest(AgentNode);

  describe("manifest", () => {
    it("publishes the core.agent kind", () => {
      expect(manifest.kind).toBe("core.agent");
    });

    it("declares the prompt input and the response/actions outputs", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual(["prompt"]);
      expect(manifest.outputs.map((port) => port.id)).toEqual([
        "response",
        "actions",
      ]);
    });

    it("declares the model/memory/workspace connection ports", () => {
      const connections = manifest.connections ?? [];
      expect(connections.map((port) => port.id)).toEqual([
        "model",
        "memory",
        "workspace",
      ]);
      expect(connections.map((port) => port.category)).toEqual([
        "model",
        "memory",
        "workspace",
      ]);
    });

    it("renders the prompt input through the crud field textarea", () => {
      const prompt = manifest.inputs.find((port) => port.id === "prompt");
      expect(prompt?.element?.tag).toBe("ngx-decaf-crud-field");
      expect(prompt?.element?.props?.["type"]).toBe("textarea");
    });
  });

  describe("execute", () => {
    it("returns an agent response echoing the routed prompt", async () => {
      const context = buildNodeContext("core.agent");
      const result = await executeNode(
        AgentNode,
        nodeExecutionRequest({ prompt: "summarise this" }),
        context
      );
      expect(result).toEqual({
        response: "[Agent response] summarise this",
        actions: [],
      });
    });

    it("returns an empty response and no actions when the prompt is missing", async () => {
      const context = buildNodeContext("core.agent");
      const result = await executeNode(
        AgentNode,
        nodeExecutionRequest({}),
        context
      );
      expect(result).toEqual({ response: "[Agent response] ", actions: [] });
    });

    it("ignores credentials on the request (no credential-gated failure path)", async () => {
      const context = buildNodeContext("core.agent");
      const result = await executeNode(
        AgentNode,
        nodeExecutionRequest({ prompt: "hi" }, { credentials: {} }),
        context
      );
      expect(result).toEqual({
        response: "[Agent response] hi",
        actions: [],
      });
    });
  });
});
