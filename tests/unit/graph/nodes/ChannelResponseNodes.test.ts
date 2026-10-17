/**
 * @module as-graph/tests/unit/graph/nodes/ChannelResponseNodes.test
 * @summary Unit tests for the SAA-836 M6 channel response node kinds
 * (`core.agent.response.slack`/`discord`/`telegram`/`teams`).
 * @description Pins the manifest surface of every built-in channel response
 * (Agent category, platform supplier icon, 96×96 size, labels, the
 * response/threadId inputs and resource output) and the fail-closed instance
 * `execute` contract: the reply is delivered only through the host-supplied
 * mastra channel delivery surface, so the general/local engine fails closed
 * with `GRAPH_LOCAL_UNSUPPORTED_NODE_KIND` instead of fabricating a delivered
 * reply.
 */
import { describe, it, expect } from "@jest/globals";
import {
  DiscordChannelResponseNode,
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
  SlackChannelResponseNode,
  TeamsChannelResponseNode,
  TelegramChannelResponseNode,
} from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { GRAPH_LOCAL_UNSUPPORTED_NODE_KIND } from "../../../../src/engine/constants";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import { buildNodeContext } from "./node-test-utils";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";

/** One row of the channel-response manifest conformance table. */
interface ChannelResponseCase {
  name: string;
  node: typeof SlackChannelResponseNode;
  kind: string;
  icon: string;
  labels: string[];
}

const CASES: ChannelResponseCase[] = [
  {
    name: "slack",
    node: SlackChannelResponseNode,
    kind: "core.agent.response.slack",
    icon: "ti-brand-slack",
    labels: ["agent", "ai", "response", "channel", "slack"],
  },
  {
    name: "discord",
    node: DiscordChannelResponseNode,
    kind: "core.agent.response.discord",
    icon: "ti-brand-discord",
    labels: ["agent", "ai", "response", "channel", "discord"],
  },
  {
    name: "telegram",
    node: TelegramChannelResponseNode,
    kind: "core.agent.response.telegram",
    icon: "ti-brand-telegram",
    labels: ["agent", "ai", "response", "channel", "telegram"],
  },
  {
    name: "teams",
    node: TeamsChannelResponseNode,
    kind: "core.agent.response.teams",
    icon: "ti-brand-teams",
    labels: ["agent", "ai", "response", "channel", "teams"],
  },
];

describe("channel response nodes (SAA-836 M6) — manifest surface", () => {
  for (const testCase of CASES) {
    describe(testCase.name, () => {
      const manifest = graphNodeManifest(testCase.node);
      const builtIn =
        GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[testCase.kind];

      it("publishes the platform channel response kind", () => {
        expect(manifest.kind).toBe(testCase.kind);
        expect(builtIn.kind).toBe(testCase.kind);
      });

      it("stays in the Agent family at trigger size with the supplier icon overlay", () => {
        // the built-in manifest (what the palette renders) overlays the
        // platform supplier icon over the Agent family's base robot
        expect(builtIn.display.category).toBe("Agent");
        expect(builtIn.display.icon?.name).toBe(testCase.icon);
        expect(builtIn.display.width).toBe(96);
        expect(builtIn.display.height).toBe(96);
        // the raw class manifest keeps the family icon fallback and the 96×96
        // response size declared on @node()
        expect(manifest.display.category).toBe("Agent");
        expect(manifest.display.icon?.name).toBe("ti-robot");
        expect(manifest.display.width).toBe(96);
        expect(manifest.display.height).toBe(96);
      });

      it("declares the platform channel labels", () => {
        expect(manifest.display.labels).toEqual(testCase.labels);
        expect(builtIn.display.labels).toEqual(testCase.labels);
      });

      it("takes the reply and conversation binding as inputs and emits the resource", () => {
        expect(manifest.inputs.map((port) => port.id)).toEqual([
          "response",
          "threadId",
        ]);
        expect(manifest.outputs.map((port) => port.id)).toEqual(["resource"]);
      });
    });
  }
});

describe("channel response nodes (SAA-836 M6) — fail-closed execute", () => {
  for (const testCase of CASES) {
    it(`fails closed with GRAPH_LOCAL_UNSUPPORTED_NODE_KIND for ${testCase.name}`, () => {
      const context = buildNodeContext(testCase.kind);
      let thrown: unknown;
      try {
        executeNode(testCase.node, nodeExecutionRequest({}), context);
        thrown = undefined;
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GraphExecutionError);
      expect((thrown as GraphExecutionError).graphCode).toBe(
        GRAPH_LOCAL_UNSUPPORTED_NODE_KIND
      );
    });
  }
});
