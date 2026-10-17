/**
 * @module as-graph/tests/integration/mastra/MastraAgentDriverRun
 * @summary SAA-837 M1 integration: a `core.trigger.chat -> core.agent` document
 * with a `modelAdapter` parameter executes through the real
 * `MastraGraphExecutionBackend` to `SUCCEEDED`, and the agent's
 * `response`/`actions` outputs are emitted.
 * @description Real: the production `MastraGraphExecutionBackend`, the
 * production `MastraWorkflowCompiler`, `createMastraDefaultStepHandlers` (real
 * `@mastra/core` `createStep`), and a real mastra run. The agent runtime is
 * host-injected through the backend's `createAgent` factory: the deterministic
 * test injects a fake agent, and the single guarded live eval injects a wrapper
 * that calls the real `pdm_ai` router model (`DeepSeek-V4.1-Flash`) through the
 * `@ai-sdk/openai-compatible` provider. The API key is read at test time from
 * `~/.config/opencode/opencode.json` (provider `pdm_ai`, resolved from the
 * `PDM_AI_API_KEY` environment variable), or the whole live suite is skipped —
 * the value is never logged, echoed, or asserted.
 *
 * Per the SAA-837 M1 scope this runs exactly ONE live eval (one agent turn);
 * the deterministic test is the reusable driver check.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
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
import { frameSinkHarness, type FrameSinkHarness } from "./helpers";

/** The opencode provider id + model the router exposes for the live eval. */
const LIVE_PROVIDER = "pdm_ai";
const LIVE_MODEL_ID = "DeepSeek-V4.1-Flash";
/** The canonical router base URL, used when the opencode config omits one. */
const LIVE_BASE_URL = "https://router.ai.pdmfc.com/v1";

/** Absolute path of the opencode config read at test time. */
const CONFIG_PATH = join(
  process.env.HOME ?? "",
  ".config",
  "opencode",
  "opencode.json"
);

/** The provider connection resolved at test time (never the key value). */
interface LiveProviderConfig {
  baseURL: string;
  apiKey: string;
}

/**
 * Resolves the live provider connection. The base URL comes from the opencode
 * config's `pdm_ai` provider (falling back to the canonical router URL); the key
 * is resolved from the `PDM_AI_API_KEY` environment variable, falling back to
 * the config's stored value.
 *
 * @returns The base URL and API key, or `undefined` when neither source yields a
 *   usable connection.
 */
function readLiveProviderConfig(): LiveProviderConfig | undefined {
  let baseURL = LIVE_BASE_URL;
  let configApiKey: string | undefined;
  try {
    if (existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
        provider?: Record<string, { options?: Record<string, unknown> }>;
      };
      const options = parsed.provider?.[LIVE_PROVIDER]?.options;
      const configuredBaseURL = options?.["baseURL"];
      const configuredApiKey = options?.["apiKey"];
      if (typeof configuredBaseURL === "string" && configuredBaseURL) {
        baseURL = configuredBaseURL;
      }
      if (typeof configuredApiKey === "string" && configuredApiKey) {
        configApiKey = configuredApiKey;
      }
    }
  } catch {
    return undefined;
  }
  const apiKey = process.env["PDM_AI_API_KEY"] ?? configApiKey;
  if (typeof apiKey !== "string" || !apiKey) return undefined;
  return { baseURL, apiKey };
}

/** Minimal structural view of the provider's language model we exercise. */
interface LiveLanguageModel {
  doGenerate(options: {
    prompt: Array<Record<string, unknown>>;
    maxOutputTokens?: number;
  }): Promise<{ content: Array<Record<string, unknown>> }>;
}

const liveConfig = readLiveProviderConfig();

/** The `@ai-sdk/openai-compatible` provider factory, when the package is installed. */
type OpenAICompatibleFactory = (options: {
  name: string;
  baseURL: string;
  apiKey: string;
}) => (modelId: string) => unknown;

/**
 * Loads the `@ai-sdk/openai-compatible` provider factory, the same provider the
 * opencode `pdm_ai` config is declared with. Loaded defensively so the suite
 * stays skip-guarded (instead of failing to run) where the package is absent.
 *
 * @returns The `createOpenAICompatible` factory, or `undefined` when unavailable.
 */
function loadOpenAICompatible(): OpenAICompatibleFactory | undefined {
  try {
    const localRequire = createRequire(__filename);
    const mod = localRequire("@ai-sdk/openai-compatible") as {
      createOpenAICompatible?: unknown;
    };
    return typeof mod.createOpenAICompatible === "function"
      ? (mod.createOpenAICompatible as OpenAICompatibleFactory)
      : undefined;
  } catch {
    return undefined;
  }
}

const createOpenAICompatible = loadOpenAICompatible();

/** A `core.trigger.chat -> core.agent` document carrying a model adapter. */
function chatAgentDocument(id: string): GraphWorkflowDocument {
  return document({
    id,
    name: id,
    nodes: [
      node("chat", "core.trigger.chat"),
      node("agent", "core.agent", {
        modelAdapter: { provider: LIVE_PROVIDER, modelId: LIVE_MODEL_ID },
      }),
    ],
    edges: [
      edge("e1", ["node", "chat", "message"], ["node", "agent", "prompt"]),
    ],
  });
}

/** Boots the mastra host over the supplied backend config. */
async function bootHost(config: MastraBackendConfig) {
  return createGraphBackendHost({ variant: "mastra", mastra: config });
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

describe("mastra agent driver run — chat -> agent (SAA-837 M1)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("executes chat -> agent to succeeded and emits the agent response/actions", async () => {
    const prompts: string[] = [];
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
      createAgent: () => ({
        generate: async (prompt: string) => {
          prompts.push(prompt);
          return { text: `echo:${prompt}`, toolCalls: [] };
        },
      }),
    });
    const backend = host.backend!;
    const harness = frameSinkHarness("saa-837-agent-driver-run");

    const result = await backend.execute({
      document: chatAgentDocument("saa-837-agent-driver-run"),
      plan: {} as never,
      inputs: { message: "summarise the brief" },
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    // The chat message was routed to the agent as its prompt.
    expect(prompts).toEqual(["summarise the brief"]);
    expect(completedOutputs(harness, "agent")).toEqual({
      response: "echo:summarise the brief",
      actions: [],
    });
    expect(
      harness.events.some(
        (event) => event.type === GraphExecutionEventType.WORKFLOW_COMPLETED
      )
    ).toBe(true);
  });
});

const describeLive =
  liveConfig && createOpenAICompatible ? describe : describe.skip;

describeLive("mastra agent driver run — live pdm_ai router (SAA-837 M1)", () => {
  it("runs one live chat -> agent turn through the real model to succeeded", async () => {
    const config = liveConfig as LiveProviderConfig;
    const providerFactory = createOpenAICompatible as OpenAICompatibleFactory;
    const provider = providerFactory({
      name: LIVE_PROVIDER,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
    const liveModel = provider(LIVE_MODEL_ID) as unknown as LiveLanguageModel;

    let modelCalls = 0;
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
      createAgent: () => ({
        generate: async (prompt: string) => {
          modelCalls += 1;
          const generated = await liveModel.doGenerate({
            prompt: [
              {
                role: "user",
                content: [{ type: "text", text: prompt }],
              },
            ],
            maxOutputTokens: 128,
          });
          const textPart = generated.content.find(
            (part) => part["type"] === "text"
          ) as { text?: string } | undefined;
          return { text: textPart?.text ?? "", toolCalls: [] };
        },
      }),
    });
    const backend = host.backend!;
    const harness = frameSinkHarness("saa-837-agent-live-run");

    const result = await backend.execute({
      document: chatAgentDocument("saa-837-agent-live-run"),
      plan: {} as never,
      inputs: { message: "Reply with exactly one word: pong" },
      options: {} as never,
      events: harness.sink,
    });

    // Report (never the key value).
    console.log(
      `[live-eval] model=${LIVE_MODEL_ID} provider=${LIVE_PROVIDER} keySource=${
        process.env["PDM_AI_API_KEY"] ? "env" : "config"
      } modelCalls=${modelCalls} status=${result.status}`
    );

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(modelCalls).toBe(1);
    const outputs = completedOutputs(harness, "agent");
    expect(typeof outputs?.["response"]).toBe("string");
    expect((outputs?.["response"] as string).length).toBeGreaterThan(0);
    expect(outputs?.["actions"]).toEqual([]);
  }, 120000);
});
