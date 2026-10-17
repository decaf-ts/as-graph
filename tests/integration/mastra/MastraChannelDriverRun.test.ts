/**
 * @module as-graph/tests/integration/mastra/MastraChannelDriverRun
 * @summary SAA-836 M6 integration: a channel trigger → agent → response graph
 * maintains conversation context across turns through the host-supplied mastra
 * channel surfaces.
 * @description Real: the production `MastraGraphExecutionBackend` (host-booted
 * via `createGraphBackendHost`), the production `MastraWorkflowCompiler`, real
 * `@mastra/core` `createStep` handlers, and a real mastra run. Host-injected
 * (the R2 extension points): a fake `createAgent` that records its generate
 * options, a `resolveChannelAdapter` factory, and a `sendChannelResponse`
 * delivery factory — the same harness pattern as the M2/M5 driver suites.
 *
 * Coverage (SAA-842 acceptance 1):
 * 1. the channel trigger forwards the inbound conversation payload
 *    (message/sessionId/userId/threadId) onto the wired agent and carries the
 *    conversation binding to the wired response node,
 * 2. two runs on the same thread bind the agent's generate calls to the same
 *    mastra memory thread and post both replies to the same channel thread —
 *    the conversation context is carried across turns by that binding,
 * 3. the fail-closed paths (`GRAPH_MASTRA_CHANNEL_UNAVAILABLE` on the trigger
 *    without a host adapter surface and on the response without a host
 *    delivery surface).
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { createMastraDefaultStepHandlers } from "../../../src/mastra/MastraDefaultStepHandlers";
import {
  GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
  type MastraBackendConfig,
} from "../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { document, edge, node } from "../../../src/workflows/builders";
import { frameSinkHarness, type FrameSinkHarness } from "./helpers";

/** The per-run generate options the fake agent records. */
interface RecordedGenerateOptions {
  memory?: { thread: string; resource?: string };
}

/** One recorded generate invocation of the fake agent. */
interface RecordedGenerateCall {
  prompt: string;
  options?: RecordedGenerateOptions;
}

/** A posted channel reply recorded by the fake delivery factory. */
interface RecordedChannelPost {
  descriptor: { platform: string; nodeId: string };
  payload: { response: unknown; threadId: unknown };
}

/** The host fakes the channel harness injects, plus their recordings. */
interface ChannelHarness {
  factoryMemories: Array<readonly unknown[] | undefined>;
  generateCalls: RecordedGenerateCall[];
  adapters: Array<{ platform: string; nodeId: string }>;
  posts: RecordedChannelPost[];
  config: MastraBackendConfig;
}

/**
 * Builds the host fakes for the channel extension points: a fake agent factory
 * that records the resolved memories and every generate call, a fake channel
 * adapter factory, and a fake channel delivery factory that records every
 * posted reply.
 */
function channelHarness(): ChannelHarness {
  const factoryMemories: Array<readonly unknown[] | undefined> = [];
  const generateCalls: RecordedGenerateCall[] = [];
  const adapters: Array<{ platform: string; nodeId: string }> = [];
  const posts: RecordedChannelPost[] = [];
  return {
    factoryMemories,
    generateCalls,
    adapters,
    posts,
    config: {
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
      createAgent: (_adapter, _agentNode, memories) => {
        factoryMemories.push(memories);
        return {
          generate: async (prompt, options) => {
            generateCalls.push({ prompt, options });
            return { text: `echo:${prompt}`, toolCalls: [] };
          },
        };
      },
      resolveChannelAdapter: (descriptor) => {
        adapters.push({
          platform: descriptor.platform,
          nodeId: descriptor.nodeId,
        });
        return { platform: descriptor.platform, adapter: true };
      },
      sendChannelResponse: (descriptor, payload) => {
        posts.push({
          descriptor: { platform: descriptor.platform, nodeId: descriptor.nodeId },
          payload: { response: payload.response, threadId: payload.threadId },
        });
        return { posted: true, platform: descriptor.platform };
      },
    },
  };
}

/**
 * The SAA-842 acceptance-1 document: a Slack channel trigger receiving the
 * conversation, an agent bound to a mastra memory thread, and the matching
 * Slack channel response posting the reply back to the same conversation.
 *
 * The conversation binding reaches the response node through its
 * user-controlled `threadId` configuration: the mastra compiler's linear step
 * chain delivers each step the previous step's output as its input, so a wired
 * `threadId` data edge cannot cross the agent hop — the response descriptor's
 * configured-binding fallback is the canonical cross-turn binding surface (the
 * wired-input override is pinned at the step-handler unit level).
 */
function channelAgentResponseDocument(id: string): GraphWorkflowDocument {
  return document({
    id,
    name: id,
    nodes: [
      node("slack-in", "core.agent.trigger.slack"),
      node("agent", "core.agent"),
      node("mem", "core.agent.memory", {
        provider: "memory",
        threadId: "thread-1",
        resourceId: "res-1",
      }),
      node("slack-out", "core.agent.response.slack", {
        threadId: "thread-1",
      }),
    ],
    edges: [
      edge("e1", ["node", "slack-in", "message"], ["node", "agent", "prompt"]),
      edge(
        "e2",
        ["node", "mem", "memory"],
        ["node", "agent", "memory"],
        "connection"
      ),
      edge(
        "e3",
        ["node", "agent", "response"],
        ["node", "slack-out", "response"]
      ),
    ],
  });
}

/** Runs a document through the real backend and returns the run result. */
async function runDocument(
  config: MastraBackendConfig,
  source: GraphWorkflowDocument,
  harness: FrameSinkHarness,
  inputs: Record<string, unknown> = {}
) {
  const host = await createGraphBackendHost({ variant: "mastra", mastra: config });
  const backend = host.backend!;
  return backend.execute({
    document: source,
    plan: {} as never,
    inputs,
    options: {} as never,
    events: harness.sink,
  });
}

/** Finds the recorded `node.completed` outputs for a node id. */
function completedOutputs(
  harness: FrameSinkHarness,
  nodeId: string
): Record<string, unknown> | undefined {
  const payload = harness.events.find(
    (event) =>
      event.type === GraphExecutionEventType.NODE_COMPLETED &&
      event.nodeId === nodeId
  )?.payload as { outputs?: Record<string, unknown> } | undefined;
  return payload?.outputs;
}

/** Finds the recorded `node.failed` error payload for a node id. */
function failedError(
  harness: FrameSinkHarness,
  nodeId: string
): { name?: string; message?: string; code?: string } | undefined {
  return harness.events.find(
    (event) =>
      event.type === GraphExecutionEventType.NODE_FAILED &&
      event.nodeId === nodeId
  )?.error as { name?: string; message?: string; code?: string } | undefined;
}

/** The run inputs of one inbound channel conversation turn. */
function turnInputs(message: string, threadId = "thread-1") {
  return {
    message,
    sessionId: "session-1",
    userId: "user-1",
    threadId,
  };
}

describe("mastra channel driver run — context across turns (SAA-842 acceptance 1)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("forwards the inbound conversation payload and posts the reply to the same thread", async () => {
    const fake = channelHarness();
    const harness = frameSinkHarness("saa-842-channel-turn-1");

    const result = await runDocument(
      fake.config,
      channelAgentResponseDocument("saa-842-channel-turn-1"),
      harness,
      turnInputs("remember the launch code is alpha-one")
    );

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);

    // the trigger forwarded the inbound conversation payload onto its outputs
    expect(completedOutputs(harness, "slack-in")).toEqual({
      message: "remember the launch code is alpha-one",
      sessionId: "session-1",
      userId: "user-1",
      threadId: "thread-1",
      resource: { platform: "slack", adapter: true },
    });

    // the agent generated against the inbound message, bound to the memory
    // thread the memory node declares
    expect(fake.generateCalls).toHaveLength(1);
    expect(fake.generateCalls[0].prompt).toBe(
      "remember the launch code is alpha-one"
    );
    expect(fake.generateCalls[0].options?.memory).toEqual({
      thread: "thread-1",
      resource: "res-1",
    });

    // the response posted the agent's reply to the same conversation binding
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]).toEqual({
      descriptor: { platform: "slack", nodeId: "slack-out" },
      payload: {
        response: "echo:remember the launch code is alpha-one",
        threadId: "thread-1",
      },
    });
    expect(completedOutputs(harness, "slack-out")?.["resource"]).toEqual({
      posted: true,
      platform: "slack",
    });
  });

  it("carries the conversation context across two turns on the same thread", async () => {
    const fake = channelHarness();

    const first = frameSinkHarness("saa-842-channel-two-turns");
    const firstResult = await runDocument(
      fake.config,
      channelAgentResponseDocument("saa-842-channel-two-turns"),
      first,
      turnInputs("my name is Ada")
    );
    expect(firstResult.status).toBe(GraphExecutionStatus.SUCCEEDED);

    const second = frameSinkHarness("saa-842-channel-two-turns");
    const secondResult = await runDocument(
      fake.config,
      channelAgentResponseDocument("saa-842-channel-two-turns"),
      second,
      turnInputs("what is my name?")
    );
    expect(secondResult.status).toBe(GraphExecutionStatus.SUCCEEDED);

    // both turns generated against their inbound message on the same mastra
    // memory thread — the carried conversation context
    expect(fake.generateCalls).toHaveLength(2);
    expect(fake.generateCalls[0].prompt).toBe("my name is Ada");
    expect(fake.generateCalls[1].prompt).toBe("what is my name?");
    expect(fake.generateCalls[0].options?.memory).toEqual({
      thread: "thread-1",
      resource: "res-1",
    });
    expect(fake.generateCalls[1].options?.memory).toEqual(
      fake.generateCalls[0].options?.memory
    );

    // and both replies were posted back to the same channel thread
    expect(fake.posts).toHaveLength(2);
    expect(fake.posts.map((post) => post.payload.threadId)).toEqual([
      "thread-1",
      "thread-1",
    ]);
    expect(fake.posts.map((post) => post.payload.response)).toEqual([
      "echo:my name is Ada",
      "echo:what is my name?",
    ]);

    // the adapter surface resolved once per run for the trigger node
    expect(fake.adapters).toEqual([
      { platform: "slack", nodeId: "slack-in" },
      { platform: "slack", nodeId: "slack-in" },
    ]);
  });
});

describe("mastra channel driver run — fail-closed paths (SAA-842 acceptance 1)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("fails the trigger closed without a host channel adapter surface", async () => {
    const fake = channelHarness();
    const noAdapterConfig: MastraBackendConfig = { ...fake.config };
    delete (noAdapterConfig as Record<string, unknown>)["resolveChannelAdapter"];
    const harness = frameSinkHarness("saa-842-channel-no-adapter");

    const result = await runDocument(
      noAdapterConfig,
      channelAgentResponseDocument("saa-842-channel-no-adapter"),
      harness,
      turnInputs("hello")
    );

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    expect(failedError(harness, "slack-in")?.code).toBe(
      GRAPH_MASTRA_CHANNEL_UNAVAILABLE
    );
    expect(fake.generateCalls).toHaveLength(0);
    expect(fake.posts).toHaveLength(0);
  });

  it("fails the response closed without a host channel delivery surface", async () => {
    const fake = channelHarness();
    const noDeliveryConfig: MastraBackendConfig = { ...fake.config };
    delete (noDeliveryConfig as Record<string, unknown>)["sendChannelResponse"];
    const harness = frameSinkHarness("saa-842-channel-no-delivery");

    const result = await runDocument(
      noDeliveryConfig,
      channelAgentResponseDocument("saa-842-channel-no-delivery"),
      harness,
      turnInputs("hello")
    );

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    // the agent still ran; the reply was never fabricated as delivered
    expect(failedError(harness, "slack-out")?.code).toBe(
      GRAPH_MASTRA_CHANNEL_UNAVAILABLE
    );
    expect(fake.generateCalls).toHaveLength(1);
    expect(fake.posts).toHaveLength(0);
  });
});
