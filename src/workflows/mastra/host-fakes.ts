/**
 * @module as-graph/workflows/mastra/host-fakes
 * @summary Deterministic host services for the default Mastra fixture suite
 * (SAA-1545 §5.2).
 * @description Supplies in-process fakes for every host port a Mastra fixture
 * can require: the agent runtime and factory, memory, MCP, channel transports,
 * voice, embedding, generation, reranking, and sandboxed code. No provider
 * credential, database, external channel, or network is used. The fakes record
 * their calls so conformance tests can assert wiring.
 */
import type { GraphNodeInstance } from "../../shared/graph/document/GraphNodeInstance";
import type { MastraBackendConfig } from "../../mastra/types";
import type { MastraAgentRuntime } from "../../mastra/MastraAgentStepHandler";
import type {
  MastraRagEmbedder,
  MastraRagTextGenerator,
  MastraReranker,
  MastraSandboxRunner,
} from "../../mastra/MastraRagStepHandlers";

/** One recorded deterministic host call. */
export interface DeterministicHostCall {
  /** The host service that was invoked (for example `createAgent`). */
  service: string;
  /** JSON-safe call details recorded by the fake. */
  detail?: Record<string, unknown>;
}

/** A deterministic host bundle: the backend config plus the call recorder. */
export interface DeterministicMastraHost {
  /** The backend config wired with in-process fakes. */
  config: MastraBackendConfig;
  /** Calls recorded in invocation order. */
  calls: DeterministicHostCall[];
}

/** A deterministic fake mastra agent exposing the `generate` contract. */
function fakeAgent(response = "deterministic mastra response") {
  return {
    generate: async (prompt: unknown) => ({
      text: response,
      object: undefined,
      toolCalls: [],
      toolResults: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
      prompt,
    }),
  };
}

/**
 * Builds a deterministic fixture host: every callback is in-process and
 * returns a stable value derived from its inputs. Each invocation appends a
 * {@link DeterministicHostCall} to the returned `calls` array.
 *
 * @param overrides - Optional backend-config overrides merged last.
 * @returns The deterministic host config and call recorder.
 * @example
 * ```ts
 * const host = createDeterministicMastraHost();
 * const result = await host.config.createAgent(undefined, agentNode, []);
 * console.log(result.text); // "deterministic mastra response"
 * console.log(host.calls[0].service); // "createAgent"
 * ```
 */
export function createDeterministicMastraHost(
  overrides: Partial<MastraBackendConfig> = {}
): DeterministicMastraHost {
  const calls: DeterministicHostCall[] = [];
  const record = (
    service: string,
    detail?: Record<string, unknown>
  ): void => {
    calls.push({ service, ...(detail ? { detail } : {}) });
  };

  const agentRuntime: MastraAgentRuntime = {
    async execute(
      node: GraphNodeInstance,
      inputData: Record<string, unknown>
    ) {
      record("agent", { nodeId: node.id, input: inputData });
      return {
        response: `deterministic response for ${node.id}`,
        actions: [],
      };
    },
  };

  const embedText: MastraRagEmbedder = async (request) => {
    record("embedText", {
      nodeId: request.node.id,
      count: request.values.length,
    });
    return request.values.map((_value, index) => [index, 1, 0]);
  };

  const generateText: MastraRagTextGenerator = async (request) => {
    record("generateText", { nodeId: request.node.id });
    return { text: `deterministic text for ${request.node.id}` };
  };

  const rerankDocuments: MastraReranker = async (request) => {
    record("rerankDocuments", {
      nodeId: request.node.id,
      count: request.documents.length,
    });
    return request.documents.map((entry, index) => ({
      document: entry,
      score: 1 / (index + 1),
    }));
  };

  const runSandboxedCode: MastraSandboxRunner = async (request) => {
    record("runSandboxedCode", {
      nodeId: request.node.id,
      language: request.language,
    });
    return request.input;
  };

  const config: MastraBackendConfig = {
    agentRuntime,
    createAgent: (adapter, node, memories) => {
      record("createAgent", {
        nodeId: node.id,
        model: adapter ? `${adapter.provider}/${adapter.modelId}` : undefined,
        memories: memories?.length ?? 0,
      });
      return fakeAgent();
    },
    createMemory: (memoryConfig, node) => {
      record("createMemory", {
        nodeId: node.id,
        provider: memoryConfig.provider,
      });
      return {
        __fakeMemory: true,
        provider: memoryConfig.provider,
        id: memoryConfig.id,
      };
    },
    createMcpServer: (descriptor) => {
      record("createMcpServer", { serverId: descriptor.serverId });
      return { __fakeMcpServer: true, serverId: descriptor.serverId };
    },
    resolveChannelAdapter: (descriptor) => {
      record("resolveChannelAdapter", {
        channel: descriptor.platform,
      });
      return {
        __fakeChannelAdapter: true,
        channel: descriptor.platform,
      };
    },
    sendChannelResponse: (descriptor, payload) => {
      record("sendChannelResponse", {
        channel: descriptor.platform,
      });
      return {
        __fakeChannelDelivery: true,
        channel: descriptor.platform,
        payload,
      };
    },
    resolveVoice: (descriptor) => {
      record("resolveVoice", { nodeId: descriptor.nodeId });
      return { __fakeVoice: true, speaker: descriptor.speaker };
    },
    embedText,
    generateText,
    rerankDocuments,
    runSandboxedCode,
    ...overrides,
  };

  return { config, calls };
}
