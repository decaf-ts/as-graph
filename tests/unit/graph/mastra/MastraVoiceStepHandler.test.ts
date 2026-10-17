/**
 * @module as-graph/tests/unit/graph/mastra/MastraVoiceStepHandler
 * @summary Unit tests for the SAA-836 M6 mastra voice step handler
 * (`core.agent.voice`).
 * @description Pins the R9 voice-configuration descriptor (mirroring mastra's
 * `VoiceConfig` shape — speaker plus speech/listening model names), the step
 * contract (the resolved live voice surface surfaces on the `resource` output),
 * and the fail-closed paths (`GRAPH_MASTRA_VOICE_UNAVAILABLE` without a host
 * voice factory or when the factory resolves nothing). The `@mastra/voice-*`
 * provider packages are not vendored, so the live surface is always
 * host-supplied (R2 extension point).
 */
import { describe, it, expect } from "@jest/globals";
import {
  createMastraVoiceStepHandler,
  GRAPH_MASTRA_VOICE_KIND,
  mastraVoiceConfigDescriptorOf,
} from "../../../../src/mastra/MastraVoiceStepHandler";
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import { GRAPH_MASTRA_VOICE_UNAVAILABLE } from "../../../../src/mastra/types";
import type { GraphNodeInstance } from "../../../../src/shared/graph/document/GraphNodeInstance";
import { document, node } from "../../../../src/workflows/builders";

/** A minimal document node instance for descriptor tests. */
function nodeInstance(
  id: string,
  kind: string,
  parameters: Record<string, unknown> = {}
): GraphNodeInstance {
  return { id, kind, parameters } as unknown as GraphNodeInstance;
}

/** Compiles a single voice node and returns its executable step. */
function compileVoiceStep(
  parameters: Record<string, unknown> = {},
  resolveVoice?: (descriptor: unknown) => unknown
): {
  execute: (args: { inputData?: unknown }) => Promise<Record<string, unknown>>;
} {
  const compiler = new MastraWorkflowCompiler({
    stepHandlers: [
      createMastraVoiceStepHandler(
        resolveVoice ? { resolveVoice } : {}
      ),
    ],
  });
  const compiled = compiler.compile(
    document({
      id: "saa-836-m6-voice",
      name: "saa-836-m6-voice",
      nodes: [node("target", "core.agent.voice", parameters)],
    })
  );
  return compiled.steps.get("target") as {
    execute: (args: { inputData?: unknown }) => Promise<Record<string, unknown>>;
  };
}

describe("mastraVoiceConfigDescriptorOf (SAA-836 M6)", () => {
  it("resolves the VoiceConfig-shaped descriptor from the node parameters", () => {
    expect(
      mastraVoiceConfigDescriptorOf(
        nodeInstance("voice", "core.agent.voice", {
          speaker: "alloy",
          speechModel: { name: "tts-1" },
          listeningModel: { name: "whisper-1" },
        }),
        "wf-voice"
      )
    ).toEqual({
      speaker: "alloy",
      speechModel: { name: "tts-1" },
      listeningModel: { name: "whisper-1" },
      workflowId: "wf-voice",
      nodeId: "voice",
    });
  });

  it("omits absent/blank fields and ignores non-record model configs", () => {
    expect(
      mastraVoiceConfigDescriptorOf(
        nodeInstance("voice", "core.agent.voice", {
          speaker: "  ",
          speechModel: "tts-1",
          listeningModel: { name: "  " },
        })
      )
    ).toEqual({ nodeId: "voice" });
  });

  it("carries the workflowId only when supplied", () => {
    expect(
      mastraVoiceConfigDescriptorOf(nodeInstance("voice", "core.agent.voice"))
    ).toEqual({ nodeId: "voice" });
  });
});

describe("mastra voice step (SAA-836 M6)", () => {
  it("surfaces the resolved host voice on the resource output", async () => {
    const resolved: unknown[] = [];
    const liveVoice = { tagged: "host-voice-surface" };
    const step = compileVoiceStep(
      { speaker: "alloy" },
      (descriptor) => {
        resolved.push(descriptor);
        return liveVoice;
      }
    );

    const output = await step.execute({ inputData: { anything: 1 } });

    expect(output).toEqual({ resource: liveVoice });
    expect(resolved).toEqual([
      expect.objectContaining({ nodeId: "target", speaker: "alloy" }),
    ]);
  });

  it("compiles the voice kind by its dedicated handler", () => {
    expect(GRAPH_MASTRA_VOICE_KIND).toBe("core.agent.voice");
    expect(createMastraVoiceStepHandler().kind).toBe("core.agent.voice");
  });

  it("fails closed with GRAPH_MASTRA_VOICE_UNAVAILABLE without a host voice factory", async () => {
    const step = compileVoiceStep({ speaker: "alloy" });
    await expect(step.execute({})).rejects.toMatchObject({
      graphCode: GRAPH_MASTRA_VOICE_UNAVAILABLE,
    });
  });

  it("fails closed when the host voice factory resolves nothing", async () => {
    for (const resolved of [undefined, null]) {
      const step = compileVoiceStep({}, () => resolved);
      await expect(step.execute({})).rejects.toMatchObject({
        graphCode: GRAPH_MASTRA_VOICE_UNAVAILABLE,
      });
    }
  });
});
