/**
 * @module as-graph/tests/unit/graph/nodes/AgentVoiceNode.test
 * @summary Unit tests for the SAA-836 M6 `core.agent.voice` node class's
 * manifest surface and fail-closed instance `execute` contract.
 * @description Pins the rounded-square speaker-icon voice node (Agent family,
 * 96×96) with the speaker/speechModel/listeningModel inputs (mastra's
 * `VoiceConfig` shape) and the resource output, and proves the general/local
 * engine never fabricates a voice capability: execute fails closed with
 * `GRAPH_LOCAL_UNSUPPORTED_NODE_KIND`.
 */
import { describe, it, expect } from "@jest/globals";
import { AgentVoiceNode, GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { GRAPH_LOCAL_UNSUPPORTED_NODE_KIND } from "../../../../src/engine/constants";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import { buildNodeContext } from "./node-test-utils";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";

describe("AgentVoiceNode", () => {
  const manifest = graphNodeManifest(AgentVoiceNode);
  const builtIn = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND["core.agent.voice"];

  describe("manifest", () => {
    it("publishes the core.agent.voice kind", () => {
      expect(manifest.kind).toBe("core.agent.voice");
      expect(builtIn.kind).toBe("core.agent.voice");
    });

    it("stays in the Agent family in a rounded 96×96 shape with the speaker icon overlay", () => {
      // the built-in manifest (what the palette renders) overlays the speaker
      // icon over the Agent family's base robot
      expect(builtIn.display.category).toBe("Agent");
      expect(builtIn.display.icon?.name).toBe("ti-volume-2");
      expect(builtIn.display.shape).toBe("rounded");
      expect(builtIn.display.width).toBe(96);
      expect(builtIn.display.height).toBe(96);
      // the raw class manifest keeps the family icon fallback and the
      // rounded 96×96 shape declared on @node()
      expect(manifest.display.category).toBe("Agent");
      expect(manifest.display.icon?.name).toBe("ti-robot");
      expect(manifest.display.shape).toBe("rounded");
      expect(manifest.display.width).toBe(96);
      expect(manifest.display.height).toBe(96);
    });

    it("carries the agent/ai/voice/speech labels", () => {
      expect(manifest.display.labels).toEqual([
        "agent",
        "ai",
        "voice",
        "speech",
      ]);
      expect(builtIn.display.labels).toEqual([
        "agent",
        "ai",
        "voice",
        "speech",
      ]);
    });

    it("takes the VoiceConfig-shaped inputs and emits the resource", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual([
        "speaker",
        "speechModel",
        "listeningModel",
      ]);
      expect(manifest.outputs.map((port) => port.id)).toEqual(["resource"]);
    });
  });

  describe("execute", () => {
    it("fails closed with GRAPH_LOCAL_UNSUPPORTED_NODE_KIND on the general engine", () => {
      const context = buildNodeContext("core.agent.voice");
      let thrown: unknown;
      try {
        executeNode(
          AgentVoiceNode,
          nodeExecutionRequest({ speaker: "alloy" }),
          context
        );
        thrown = undefined;
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GraphExecutionError);
      expect((thrown as GraphExecutionError).graphCode).toBe(
        GRAPH_LOCAL_UNSUPPORTED_NODE_KIND
      );
    });
  });
});
