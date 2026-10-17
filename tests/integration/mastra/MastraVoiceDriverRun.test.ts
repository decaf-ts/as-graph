/**
 * @module as-graph/tests/integration/mastra/MastraVoiceDriverRun
 * @summary SAA-836 M6 integration: a `core.agent.voice` node compiles and runs
 * on the real mastra backend, surfacing the resolved host voice on its
 * `resource` output.
 * @description Real: the production `MastraGraphExecutionBackend` (host-booted
 * via `createGraphBackendHost`), the production `MastraWorkflowCompiler`, real
 * `@mastra/core` `createStep` handlers, and a real mastra run. Host-injected
 * (the R2 extension point): a `resolveVoice` factory resolving the live mastra
 * voice surface (e.g. the wired agent's `getVoice()`) — the `@mastra/voice-*`
 * provider packages are not vendored, so without the host factory the node
 * fails closed with `GRAPH_MASTRA_VOICE_UNAVAILABLE`.
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
  GRAPH_MASTRA_VOICE_UNAVAILABLE,
  type MastraBackendConfig,
} from "../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { document, node } from "../../../src/workflows/builders";
import { frameSinkHarness, type FrameSinkHarness } from "./helpers";

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

/** A document with one voice node declaring the mastra VoiceConfig shape. */
function voiceDocument(id: string): GraphWorkflowDocument {
  return document({
    id,
    name: id,
    nodes: [
      node("voice", "core.agent.voice", {
        speaker: "alloy",
        speechModel: { name: "tts-1" },
        listeningModel: { name: "whisper-1" },
      }),
    ],
  });
}

describe("mastra voice driver run (SAA-842 acceptance 3)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("resolves the host voice surface onto the resource output", async () => {
    const resolvedDescriptors: unknown[] = [];
    const liveVoice = { tagged: "host-voice", getVoice: () => "live" };
    const harness = frameSinkHarness("saa-842-voice-resolved-run");

    const host = await createGraphBackendHost({
      variant: "mastra",
      mastra: {
        mastra: {},
        stepHandlers: createMastraDefaultStepHandlers(),
        resolveVoice: (descriptor) => {
          resolvedDescriptors.push(descriptor);
          return liveVoice;
        },
      } as MastraBackendConfig,
    });
    const result = await host.backend!.execute({
      document: voiceDocument("saa-842-voice-resolved-run"),
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(completedOutputs(harness, "voice")?.["resource"]).toBe(liveVoice);
    // the voice node's VoiceConfig-shaped parameters reached the host factory
    expect(resolvedDescriptors).toEqual([
      expect.objectContaining({
        nodeId: "voice",
        speaker: "alloy",
        speechModel: { name: "tts-1" },
        listeningModel: { name: "whisper-1" },
      }),
    ]);
  });

  it("fails closed with GRAPH_MASTRA_VOICE_UNAVAILABLE without a host voice factory", async () => {
    const harness = frameSinkHarness("saa-842-voice-fail-closed-run");

    const host = await createGraphBackendHost({
      variant: "mastra",
      mastra: {
        mastra: {},
        stepHandlers: createMastraDefaultStepHandlers(),
      } as MastraBackendConfig,
    });
    const result = await host.backend!.execute({
      document: voiceDocument("saa-842-voice-fail-closed-run"),
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    expect(failedError(harness, "voice")?.code).toBe(
      GRAPH_MASTRA_VOICE_UNAVAILABLE
    );
  });
});
