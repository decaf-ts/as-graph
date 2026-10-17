/**
 * @module as-graph/tests/unit/graph/nodes/ChannelTriggerNodes.test
 * @summary Unit tests for the SAA-836 M6 channel trigger node kinds
 * (`core.agent.trigger.slack`/`discord`/`telegram`/`teams`).
 * @description Pins the manifest surface of every built-in channel trigger
 * (Agent category, platform supplier icon, 96×96 size, labels, the
 * message/sessionId/userId/threadId/resource outputs, no inputs) and the
 * fail-closed instance `execute` contract: the general/local engine cannot run
 * a channel trigger, so every execute throws
 * `GRAPH_LOCAL_UNSUPPORTED_NODE_KIND` instead of fabricating a channel
 * endpoint.
 */
import { describe, it, expect } from "@jest/globals";
import {
  DiscordChannelTriggerNode,
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
  SlackChannelTriggerNode,
  TeamsChannelTriggerNode,
  TelegramChannelTriggerNode,
} from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { GRAPH_LOCAL_UNSUPPORTED_NODE_KIND } from "../../../../src/engine/constants";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import {
  executeNode,
  nodeExecutionRequest,
} from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

/** One row of the channel-trigger manifest conformance table. */
interface ChannelTriggerCase {
  name: string;
  node: typeof SlackChannelTriggerNode;
  kind: string;
  icon: string;
  labels: string[];
}

const CASES: ChannelTriggerCase[] = [
  {
    name: "slack",
    node: SlackChannelTriggerNode,
    kind: "core.agent.trigger.slack",
    icon: "ti-brand-slack",
    labels: ["agent", "ai", "trigger", "channel", "slack"],
  },
  {
    name: "discord",
    node: DiscordChannelTriggerNode,
    kind: "core.agent.trigger.discord",
    icon: "ti-brand-discord",
    labels: ["agent", "ai", "trigger", "channel", "discord"],
  },
  {
    name: "telegram",
    node: TelegramChannelTriggerNode,
    kind: "core.agent.trigger.telegram",
    icon: "ti-brand-telegram",
    labels: ["agent", "ai", "trigger", "channel", "telegram"],
  },
  {
    name: "teams",
    node: TeamsChannelTriggerNode,
    kind: "core.agent.trigger.teams",
    icon: "ti-brand-teams",
    labels: ["agent", "ai", "trigger", "channel", "teams"],
  },
];

describe("channel trigger nodes (SAA-836 M6) — manifest surface", () => {
  for (const testCase of CASES) {
    describe(testCase.name, () => {
      const manifest = graphNodeManifest(testCase.node);
      const builtIn =
        GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[testCase.kind];

      it("publishes the platform channel trigger kind", () => {
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
        // trigger size declared on @node()
        expect(manifest.display.category).toBe("Agent");
        expect(manifest.display.icon?.name).toBe("ti-robot");
        expect(manifest.display.width).toBe(96);
        expect(manifest.display.height).toBe(96);
      });

      it("declares the platform channel labels", () => {
        expect(manifest.display.labels).toEqual(testCase.labels);
        expect(builtIn.display.labels).toEqual(testCase.labels);
      });

      it("declares no inputs and the message/sessionId/userId/threadId/resource outputs", () => {
        expect(manifest.inputs).toEqual([]);
        expect(manifest.outputs.map((port) => port.id)).toEqual([
          "message",
          "sessionId",
          "userId",
          "threadId",
          "resource",
        ]);
      });
    });
  }
});

describe("channel trigger nodes (SAA-836 M6) — fail-closed execute", () => {
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
