/**
 * @module as-graph/tests/integration/mastra/MastraProcessorGuardrailRun
 * @summary SAA-836 M5 integration: an agent node wired with an input-processor,
 * an output-processor, and a guardrail node executes through the real
 * `MastraGraphExecutionBackend`, the config-backed runtime forwards the wired
 * pipelines as mastra's per-run `inputProcessors`/`outputProcessors` generate
 * overrides, and a `block`-strategy guardrail aborts the run via mastra's
 * tripwire (`FAILED`).
 * @description Real: the production backend, compiler, default handler set
 * (real `@mastra/core` `createStep`), and a real mastra run. Host-injected: a
 * fake agent (no model provider) that records its `generate` options and — for
 * the tripwire case — applies the wired output processors the way a real
 * mastra agent applies `outputProcessors` over the model result.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { createMastraDefaultStepHandlers } from "../../../src/mastra/MastraDefaultStepHandlers";
import type { MastraBackendConfig } from "../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { document, edge, node } from "../../../src/workflows/builders";
import { frameSinkHarness } from "./helpers";

/** The generate options a real mastra agent receives (the M5 surface). */
interface RecordedGenerateOptions {
  inputProcessors?: unknown[];
  outputProcessors?: unknown[];
}

/** One recorded generate invocation of the fake agent. */
interface RecordedGenerateCall {
  prompt: string;
  options?: RecordedGenerateOptions;
}

/**
 * A fake agent that records its generate prompt and per-run options, and —
 * when the test sets `applyOutputProcessors` — applies the wired output
 * processors the way a real mastra agent applies `outputProcessors` over the
 * model result.
 */
interface RecordingAgent {
  calls: RecordedGenerateCall[];
  generate: (
    prompt: string,
    options?: RecordedGenerateOptions
  ) => Promise<{ text: string; toolCalls: unknown[] }>;
}

/** Builds the mastra backend config whose fake agent records generate overrides. */
function recordingAgentConfig(applyOutputProcessors = false): {
  createAgent: () => RecordingAgent;
  agent: RecordingAgent;
} {
  const calls: RecordedGenerateCall[] = [];
  const agent: RecordingAgent = {
    calls,
    generate: async (prompt, options) => {
      calls.push({ prompt, options });
      if (applyOutputProcessors) {
        const messages = [
          {
            role: "assistant",
            content: {
              parts: [{ type: "text", text: `model output for ${prompt}` }],
            },
          },
        ];
        for (const processor of options.outputProcessors ?? []) {
          (
            processor as {
              processOutputResult?: (args: { messages: unknown }) => unknown;
            }
          ).processOutputResult?.({ messages });
        }
      }
      return { text: `model output for ${prompt}`, toolCalls: [] };
    },
  };
  return {
    agent,
    createAgent: () => agent,
  };
}

/** An agent wired with one input-processor and one output-processor node. */
function processorPairDocument(
  id: string,
  agentParameters: Record<string, unknown> = {}
): GraphWorkflowDocument {
  return document({
    id,
    name: id,
    nodes: [
      node("chat", "core.trigger.chat"),
      node("agent", "core.agent", agentParameters),
      node("normalize", "core.agent.inputProcessor", {
        processorType: "unicodeNormalizer",
      }),
      node("limit", "core.agent.outputProcessor", {
        processorType: "tokenLimiter",
      }),
    ],
    edges: [
      edge("e1", ["node", "chat", "message"], ["node", "agent", "prompt"]),
      edge(
        "e2",
        ["node", "normalize", "processor"],
        ["node", "agent", "inputProcessors"],
        "connection"
      ),
      edge(
        "e3",
        ["node", "limit", "processor"],
        ["node", "agent", "outputProcessors"],
        "connection"
      ),
    ],
  });
}

/** An agent wired with a block-strategy regex guardrail on its output zone. */
function guardedAgentDocument(id: string, blockedText: string): GraphWorkflowDocument {
  return document({
    id,
    name: id,
    nodes: [
      node("chat", "core.trigger.chat"),
      node("agent", "core.agent"),
      node("blocker", "core.agent.guardrail", {
        guardrailType: "regexFilter",
        strategy: "block",
        options: {
          rules: [{ pattern: new RegExp(blockedText), name: "leak" }],
        },
      }),
    ],
    edges: [
      edge("e1", ["node", "chat", "message"], ["node", "agent", "prompt"]),
      edge(
        "e2",
        ["node", "blocker", "guardrail"],
        ["node", "agent", "outputProcessors"],
        "connection"
      ),
    ],
  });
}

/** Boots the mastra host over the supplied backend config. */
async function bootHost(config: MastraBackendConfig) {
  return createGraphBackendHost({ variant: "mastra", mastra: config });
}

describe("mastra processor/guardrail driver run (SAA-836 M5)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("forwards the wired processor pair as per-run generate overrides", async () => {
    const fake = recordingAgentConfig();
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
      createAgent: fake.createAgent,
    });
    const backend = host.backend!;
    const harness = frameSinkHarness("saa-836-processor-pair-run");

    const result = await backend.execute({
      document: processorPairDocument("saa-836-processor-pair-run"),
      plan: {} as never,
      inputs: { message: "summarise the brief" },
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    // The fake agent received mastra's per-run processor overrides, resolved
    // from the wired zones into real @mastra/core/processors instances.
    expect(fake.agent.calls).toHaveLength(1);
    const generateOptions = fake.agent.calls[0].options;
    expect(generateOptions?.inputProcessors).toHaveLength(1);
    expect(generateOptions?.outputProcessors).toHaveLength(1);
    expect(
      generateOptions?.inputProcessors?.[0].constructor.name
    ).toBe("UnicodeNormalizer");
    expect(
      generateOptions?.outputProcessors?.[0].constructor.name
    ).toBe("TokenLimiterProcessor");
    expect(
      harness.events.some(
        (event) => event.type === GraphExecutionEventType.WORKFLOW_COMPLETED
      )
    ).toBe(true);
  });

  it("leaves the generate overrides absent when no processor is wired", async () => {
    const fake = recordingAgentConfig();
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
      createAgent: fake.createAgent,
    });
    const backend = host.backend!;
    const harness = frameSinkHarness("saa-836-no-processor-run");

    const result = await backend.execute({
      document: document({
        id: "saa-836-no-processor-run",
        name: "saa-836-no-processor-run",
        nodes: [
          node("chat", "core.trigger.chat"),
          node("agent", "core.agent"),
        ],
        edges: [
          edge("e1", ["node", "chat", "message"], ["node", "agent", "prompt"]),
        ],
      }),
      plan: {} as never,
      inputs: { message: "plain run" },
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(fake.agent.calls[0].options?.inputProcessors).toBeUndefined();
    expect(fake.agent.calls[0].options?.outputProcessors).toBeUndefined();
  });

  it("aborts the run FAILED when the wired guardrail trips (block strategy)", async () => {
    const fake = recordingAgentConfig(true);
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
      createAgent: fake.createAgent,
    });
    const backend = host.backend!;
    const harness = frameSinkHarness("saa-836-guardrail-tripwire");

    const result = await backend.execute({
      document: guardedAgentDocument(
        "saa-836-guardrail-tripwire",
        "output for"
      ),
      plan: {} as never,
      inputs: { message: "echo the secret" },
      options: {} as never,
      events: harness.sink,
    });

    // The fake agent applied the wired guardrail the way mastra does; the
    // real `RegexFilterProcessor` with the `block` strategy raised mastra's
    // TripWire, aborting agent execution.
    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    const types = harness.events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.NODE_FAILED);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_FAILED);
    expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_COMPLETED);
  }, 15_000);

  it("lets the run succeed when the wired guardrail does not match", async () => {
    const fake = recordingAgentConfig(true);
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
      createAgent: fake.createAgent,
    });
    const backend = host.backend!;
    const harness = frameSinkHarness("saa-836-guardrail-pass");

    const result = await backend.execute({
      document: guardedAgentDocument(
        "saa-836-guardrail-pass",
        "NEVER-MATCHES"
      ),
      plan: {} as never,
      inputs: { message: "echo the secret" },
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(
      harness.events.some(
        (event) => event.type === GraphExecutionEventType.WORKFLOW_COMPLETED
      )
    ).toBe(true);
  }, 15_000);
});
