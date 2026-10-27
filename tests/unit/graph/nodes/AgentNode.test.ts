/**
 * @module as-graph/tests/unit/graph/nodes/AgentNode.test
 * @summary Dedicated unit tests for the `core.agent` node class's manifest
 * surface and its mastra-only `execute` contract (SAA-837 M1).
 * @description SAA-837 M1 removed the `core.agent` echo/degraded placeholder:
 * the agent kind is now mastra-only and its direct node execution fails closed
 * without a host agent service (the local engine gate rejects it earlier), and
 * the manifest carries the full CRUD agent configuration plus the dedicated
 * mastra connection zones (SAA-836 M1/M3).
 */
import { AgentNode } from "../../../../src/mastra/nodes";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import { GRAPH_MASTRA_AGENT_UNAVAILABLE } from "../../../../src/mastra/types";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("AgentNode", () => {
  const manifest = graphNodeManifest(AgentNode);

  describe("manifest", () => {
    it("publishes the core.agent kind", () => {
      expect(manifest.kind).toBe("core.agent");
    });

    it("declares the agent configuration inputs and the response/actions outputs", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual([
        "prompt",
        "name",
        "description",
        "instructions",
        "skillsFormat",
        "maxRetries",
        "modelAdapter",
        "structuredOutput",
        "agentOptions",
      ]);
      expect(manifest.outputs.map((port) => port.id)).toEqual([
        "response",
        "actions",
      ]);
    });

    it("declares the mastra agent connection ports with matching categories", () => {
      const connections = manifest.connections ?? [];
      expect(connections.map((port) => port.id)).toEqual([
        "memory",
        "scorers",
        "embedding",
        "hooks",
        "sandbox",
        "tools",
        "skill",
        "inputProcessors",
        "outputProcessors",
        "model",
        "workspace",
      ]);
      expect(connections.map((port) => port.category)).toEqual([
        "memory",
        "scorers",
        "embedding",
        "hooks",
        "sandbox",
        "tools",
        "skill",
        "inputProcessors",
        "outputProcessors",
        "model",
        "workspace",
      ]);
    });

    it("publishes the declared zone placement of every connection port", () => {
      const zones = Object.fromEntries(
        (manifest.connections ?? []).map((port) => [port.id, port.zone])
      );
      expect(zones).toEqual({
        memory: { side: "bottom", align: "start", order: 0 },
        scorers: { side: "top", align: "end", order: 0 },
        embedding: { side: "bottom", align: "end", order: 0 },
        hooks: { side: "top", align: "center", order: 0 },
        sandbox: { side: "top", align: "center", order: 1 },
        tools: { side: "bottom", align: "center", order: 0 },
        skill: { side: "bottom", align: "center", order: 1 },
        inputProcessors: { side: "top", align: "center", order: 2 },
        outputProcessors: { side: "bottom", align: "center", order: 2 },
        model: { side: "bottom", align: "start", order: 1 },
        workspace: { side: "bottom", align: "start", order: 2 },
      });
    });

    it("renders the prompt input through the crud field textarea", () => {
      const prompt = manifest.inputs.find((port) => port.id === "prompt");
      expect(prompt?.element?.tag).toBe("ngx-decaf-crud-field");
      expect(prompt?.element?.props?.["type"]).toBe("textarea");
    });
  });

  describe("execute", () => {
    it.each([
      ["a routed prompt", { prompt: "summarise this" }, {}],
      ["a missing prompt", {}, {}],
      ["credentials on the request", { prompt: "hi" }, { credentials: {} }],
    ])(
      "fails closed with GRAPH_MASTRA_AGENT_UNAVAILABLE without a host runtime (%s)",
      async (_label, inputs, overrides) => {
        const context = buildNodeContext("core.agent");
        let thrown: unknown;
        try {
          await executeNode(
            AgentNode,
            nodeExecutionRequest(inputs, { kind: "core.agent", ...overrides }),
            context
          );
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(GraphExecutionError);
        expect((thrown as GraphExecutionError).graphCode).toBe(
          GRAPH_MASTRA_AGENT_UNAVAILABLE
        );
        expect((thrown as GraphExecutionError).details).toMatchObject({
          nodeId: "TestNode",
          kind: "core.agent",
          service: "agent",
        });
      }
    );
  });
});
