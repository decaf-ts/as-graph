/**
 * @module as-graph/tests/integration/mastra/MastraAgentLiveToolCall
 * @summary Live IT (SAA-850 scope addition 4): a real OpenAI-compatible turn
 * against the `pdm_ai` router selects and executes one M3 `@tool`-converted
 * mastra tool.
 * @description Real: the `@ai-sdk/openai-compatible` language model built from
 * the opencode config (`$HOME/.config/opencode/opencode.json`, read at test
 * time), the live `DeepSeek-V4.1-Flash` router endpoint, and the M3
 * `@tool` decorator + `mastraToolsFromService` conversion path. The tool the
 * model selects is declared to the router from the `@tool` metadata and the
 * call is executed by the real mastra tool. The config stores the key as an
 * opencode `{env:...}` reference (`{env:PDM_AI_API_KEY}`), which this test
 * resolves from the environment at test time — the key value is never logged,
 * echoed, or asserted; the whole suite is skip-guarded when the config, the
 * reference, or the resolved key is absent so it never fails an environment
 * without the router.
 *
 * Per the scope-addition contract this runs **exactly one** live eval (one tool
 * call) and records the model id, the last HTTP status, and whether the key was
 * found. It calls the provider's `doGenerate` directly rather than a mastra
 * `Agent` because `Agent.generate`'s agentic loop performs an ESM `import()` the
 * CommonJS jest runtime rejects ("dynamic import callback was invoked without
 * --experimental-vm-modules"); the model, the router, and the M3 tool path are
 * the real ones either way.
 */
import { describe, it, expect } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { model } from "@decaf-ts/decorator-validation";
import {
  tool,
  serviceToolMethods,
  mastraToolsFromService,
} from "../../../src/mastra/MastraToolDecorator";

/** The opencode provider id + model the router exposes for tool calls. */
const LIVE_PROVIDER = "pdm_ai";
const LIVE_MODEL_ID = "DeepSeek-V4.1-Flash";

/** Absolute path of the opencode config read at test time. */
const CONFIG_PATH = join(
  process.env.HOME ?? "",
  ".config",
  "opencode",
  "opencode.json"
);

/** The provider connection read from the opencode config (never the key value). */
interface LiveProviderConfig {
  baseURL: string;
  apiKey: string;
}

/** Minimal structural view of the provider's language model we exercise. */
interface LiveLanguageModel {
  specificationVersion: string;
  doGenerate(options: LiveGenerateOptions): Promise<LiveGenerateResult>;
}

/** Minimal structural view of a `doGenerate` call. */
interface LiveGenerateOptions {
  prompt: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: Record<string, unknown>;
  maxOutputTokens?: number;
}

/** Minimal structural view of a `doGenerate` result. */
interface LiveGenerateResult {
  content: Array<Record<string, unknown>>;
  finishReason?: { unified?: string } | string;
}

/** A mastra tool produced by {@link mastraToolsFromService}. */
interface LiveMastraTool {
  id: string;
  execute(input: unknown): Promise<unknown>;
}

/**
 * Resolves an opencode config value, expanding an `{env:NAME}` reference from
 * the environment. A literal value is returned as-is; an unresolvable
 * reference returns `undefined`. Never logs the value.
 *
 * @param value - The raw config value (literal or `{env:NAME}` reference).
 * @returns The resolved value, or `undefined` when it cannot be resolved.
 */
function resolveConfigValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const envRef = /^\{env:([A-Za-z0-9_]+)\}$/.exec(value);
  if (envRef) {
    const resolved = process.env[envRef[1]];
    return resolved && resolved.length > 0 ? resolved : undefined;
  }
  return value;
}

/**
 * Reads the `pdm_ai` provider connection from the opencode config at test time,
 * expanding any `{env:...}` reference from the environment.
 *
 * @returns The base URL and API key, or `undefined` when the config is missing,
 *   unreadable, or lacks a usable provider entry.
 */
function readLiveProviderConfig(): LiveProviderConfig | undefined {
  try {
    if (!existsSync(CONFIG_PATH)) return undefined;
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
      provider?: Record<string, { options?: Record<string, unknown> }>;
    };
    const options = parsed.provider?.[LIVE_PROVIDER]?.options;
    const baseURL = resolveConfigValue(options?.["baseURL"]);
    const apiKey = resolveConfigValue(options?.["apiKey"]);
    if (!baseURL || !apiKey) return undefined;
    return { baseURL, apiKey };
  } catch {
    return undefined;
  }
}

const liveConfig = readLiveProviderConfig();

/** The `@ai-sdk/openai-compatible` provider factory, when the package is installed. */
type OpenAICompatibleFactory = (options: {
  name: string;
  baseURL: string;
  apiKey: string;
  fetch?: typeof fetch;
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

/** A service whose `@tool` method is the live tool call target. */
@model()
class WeatherService {
  /** Records every input the model supplied to the tool. */
  calls: Array<{ city?: unknown }> = [];

  /**
   * A `@tool`-decorated method mirrored as a real mastra tool (SAA-836 M3).
   *
   * @param input - The tool input the model supplied.
   * @returns A deterministic weather string.
   */
  @tool({
    id: "get_weather",
    description: "Get the current weather for a city by name.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  })
  async getWeather(input: { city?: unknown }): Promise<string> {
    this.calls.push(input);
    return `sunny in ${String(input.city)}`;
  }
}

const describeLive =
  liveConfig && createOpenAICompatible ? describe : describe.skip;

describeLive("live mastra tool call — pdm_ai router (SAA-850 addition 4)", () => {
  it("selects and executes one M3 @tool mastra tool on a live DeepSeek turn", async () => {
    const config = liveConfig as LiveProviderConfig;
    const providerFactory = createOpenAICompatible as OpenAICompatibleFactory;

    const service = new WeatherService();
    const tools = mastraToolsFromService(service) as Record<
      string,
      LiveMastraTool
    >;
    expect(Object.keys(tools)).toEqual(["get_weather"]);

    // Capture the router's HTTP status without a second network call.
    let lastHttpStatus: number | undefined;
    const recordingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      lastHttpStatus = response.status;
      return response;
    };

    const provider = providerFactory({
      name: LIVE_PROVIDER,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      fetch: recordingFetch,
    });
    const liveModel = provider(LIVE_MODEL_ID) as unknown as LiveLanguageModel;

    const methods = serviceToolMethods(WeatherService);
    const result = await liveModel.doGenerate({
      prompt: [
        {
          role: "system",
          content:
            "You are a weather assistant. You MUST call the get_weather tool before answering.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "What is the weather in Paris right now?" },
          ],
        },
      ],
      tools: methods.map((method) => ({
        type: "function",
        name: method.id,
        description: method.description,
        inputSchema: method.inputSchema,
      })),
      toolChoice: { type: "auto" },
      maxOutputTokens: 256,
    });

    const toolCall = result.content.find(
      (part) => part["type"] === "tool-call"
    ) as { toolName: string; input: unknown } | undefined;

    expect(toolCall).toBeDefined();
    const selectedTool = tools[toolCall!.toolName];
    expect(selectedTool).toBeDefined();

    // The low-level provider hands back the model's raw `arguments` string; the
    // AI SDK's agent path parses it before invoking the tool, so mirror that.
    const toolInput =
      typeof toolCall!.input === "string"
        ? JSON.parse(toolCall!.input)
        : toolCall!.input;
    const output = await selectedTool.execute(toolInput);

    // Report (never the key value).
    console.log(
      `[live-eval] model=${LIVE_MODEL_ID} httpStatus=${
        lastHttpStatus ?? "unknown"
      } keyFound=true toolName=${toolCall!.toolName} serviceInvocations=${
        service.calls.length
      } toolOutput=${JSON.stringify(output)}`
    );

    expect(service.calls.length).toBe(1);
    expect(service.calls[0]).toHaveProperty("city");
  }, 120000);
});
