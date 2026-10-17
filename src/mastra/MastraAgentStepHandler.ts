/**
 * @module as-graph/mastra/MastraAgentStepHandler
 * @summary Real `core.agent` execution for the mastra backend (SAA-837 M1).
 * @description Replaces the SAA-824 degraded echo placeholder with a genuine
 * agent step. The handler builds a `@mastra/core` step that resolves the agent
 * configured for the node (from the host's agent map or an injected factory),
 * invokes it with the node's resolved `prompt` input, and projects the agent
 * result onto the canonical `response`/`actions` outputs. Execution fails closed
 * with {@link GRAPH_MASTRA_AGENT_UNAVAILABLE} when no agent (or no agent runtime)
 * is available, so the engine never reports a fabricated agent result. When the
 * compiled document wires processor/guardrail nodes onto the agent's
 * `inputProcessors`/`outputProcessors` zones (SAA-836 M5), the handler resolves
 * them into real `@mastra/core/processors` instances and hands them to the
 * runtime as mastra's per-run processor overrides (R3). When the document wires
 * memory provider nodes onto the agent's `memory` zone (SAA-836 M2), the
 * handler resolves them into live mastra-native `Memory` instances, hands them
 * to the agent factory for construction-time attachment, and binds the
 * invocation to the configured thread via mastra's per-run `memory` option.
 * When the node declares a `structuredOutput` definition (SAA-836 S1), the
 * handler resolves it into mastra's per-run `structuredOutput` generate option
 * through the backend structured-output contract (see
 * {@link MastraStructuredOutput}) and the resolved Zod schema drives and
 * validates the response.
 *
 * The runtime is deliberately expressed as a port ({@link MastraAgentRuntime}):
 * the backend passes the config-backed implementation, while tests can inject a
 * deterministic fake agent without a model provider or credentials.
 */
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import {
  GRAPH_MASTRA_AGENT_UNAVAILABLE,
  GRAPH_MASTRA_MEMORY_UNAVAILABLE,
  type MastraNodeStepHandler,
  type MastraNodeStepOptions,
} from "./types";
import {
  graphModelAdapterOf,
  mastraModelConfigOf,
  type MastraModelAdapterConfig,
} from "./MastraAgentModelAdapter";
import {
  connectedMastraMemoryWiringOf,
  resolveMastraMemory,
  type MastraAgentMemoryWiring,
  type MastraMemoryConfig,
} from "./MastraMemory";
import {
  resolveAgentWiredProcessors,
  type MastraAgentWiredProcessors,
  type MastraProcessorModelResolver,
} from "./MastraAgentProcessors";
import {
  mastraStructuredOutputOf,
  type MastraDecafModelResolver,
  type MastraResolvedStructuredOutput,
} from "./MastraStructuredOutput";

/**
 * Host port that performs the actual agent invocation for one `core.agent` node.
 * The backend supplies a config-backed implementation; tests supply a fake.
 */
export interface MastraAgentRuntime {
  /**
   * Runs the agent configured for `node` against the node's resolved inputs.
   *
   * @param node - The canonical node instance (carries the model-adapter config).
   * @param inputData - The resolved node input values (`prompt`, …).
   * @param signal - The step's abort signal, when the runtime supplies one.
   * @param processors - The wired processor pipelines (SAA-836 M5) resolved
   *   from the agent node's `inputProcessors`/`outputProcessors` zones, when
   *   the document declares any. Applied by the config-backed runtime as
   *   mastra's per-run processor overrides (R3).
   * @param memories - The live mastra memories resolved from the agent node's
   *   wired `memory` zone (SAA-836 M2), when any memory provider is connected.
   * @param structuredOutput - The structured-output option resolved from the
   *   node's `structuredOutput` definition (SAA-836 S1), when the node
   *   declares one. Applied by the config-backed runtime as mastra's
   *   per-run `structuredOutput` option.
   * @returns The canonical agent outputs (`response`, `actions`).
   */
  execute(
    node: GraphNodeInstance,
    inputData: Record<string, unknown>,
    signal?: AbortSignal,
    processors?: MastraAgentWiredProcessors,
    memories?: readonly MastraAgentMemoryWiring[],
    structuredOutput?: MastraResolvedStructuredOutput
  ): Promise<Record<string, unknown>>;
}

/** Options a {@link createMastraAgentStepHandler} handler set is built with. */
export interface MastraAgentStepHandlerOptions {
  /** The agent runtime; when omitted, `core.agent` fails closed. */
  runtime?: MastraAgentRuntime;
  /**
   * Host hook resolving the classifier model a model-carrying wired processor
   * or guardrail runs on (SAA-836 M5, R1). Forwarded to the processor
   * resolution; when omitted, the composed `<provider>/<modelId>` id is used.
   */
  resolveProcessorModel?: MastraProcessorModelResolver;
  /**
   * Host decaf-model registry resolving a structured-output definition's model
   * name to its constructor (SAA-836 S1). The resolved model converts to the
   * mastra Zod schema through `@decaf-ts/as-zod` (the single conversion path).
   * When omitted, a definition that references a model by name fails closed.
   */
  resolveModel?: MastraDecafModelResolver;
}

/**
 * Host-provided resolution of a live `@mastra/core` agent. Either a named agent
 * map (keyed by `<provider>/<modelId>`, model id, or node id) or a factory that
 * builds one from the node's model-adapter config, or both.
 */
export interface MastraAgentFactoryOptions {
  /** Named mastra agents keyed by model id or node id. */
  agents?: Record<string, unknown>;
  /**
   * Builds a live agent from the node's model-adapter config. Called only when
   * the named map has no matching entry.
   *
   * @param adapter - The validated model-adapter config, when present.
   * @param node - The canonical node instance.
   * @param memories - The live mastra memories resolved from the agent node's
   *   wired `memory` zone (SAA-836 M2), for factories that attach memory at
   *   construction; absent when no memory provider is wired.
   * @returns The live mastra agent (or a thenable of one).
   */
  createAgent?: (
    adapter: MastraModelAdapterConfig | undefined,
    node: GraphNodeInstance,
    memories?: readonly unknown[]
  ) => unknown | Promise<unknown>;
  /**
   * Optional named memory map (SAA-836 M2), keyed by the wiring memory node's
   * id, its config id, or its provider. Consulted before {@link createMemory}
   * and the built-in resolution.
   */
  memories?: Record<string, unknown>;
  /**
   * Optional factory building a live mastra memory from a wired memory node's
   * config (SAA-836 M2). Consulted after the {@link memories} map and before
   * the built-in mastra-native wrap.
   */
  createMemory?: (
    config: MastraMemoryConfig,
    node: GraphNodeInstance
  ) => unknown | Promise<unknown>;
}

/**
 * Extracts the prompt the agent is invoked with. Prefers the resolved `prompt`
 * input, then a `message` input (chat triggers), then the node's configured
 * `prompt` parameter, and finally an empty string.
 *
 * @param node - The canonical node instance.
 * @param inputData - The resolved node input values.
 * @returns The prompt string.
 */
function promptOf(
  node: GraphNodeInstance,
  inputData: Record<string, unknown>
): string {
  const candidates = [
    inputData["prompt"],
    inputData["message"],
    node.parameters?.["prompt"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

/**
 * Projects a mastra agent result onto the canonical `response`/`actions`
 * outputs. Tolerates the common result shapes (`text`, `response`,
 * `toolCalls`, `toolResults`, `steps`) without inventing data.
 *
 * @param result - The raw agent result.
 * @returns The canonical output values.
 */
function agentOutputOf(result: unknown): Record<string, unknown> {
  if (typeof result === "string") {
    return { response: result, actions: [] };
  }
  const record =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  const text = record["text"] ?? record["response"];
  const actions = record["toolCalls"] ?? record["toolResults"] ?? record["steps"];
  return {
    response: typeof text === "string" ? text : "",
    actions: Array.isArray(actions) ? actions : [],
  };
}

/**
 * Resolves the live mastra memories for the wired `memory` zone (SAA-836 M2).
 * Per wiring entry, resolution order: the host memory map (by wiring node id,
 * config id, then provider), the host factory, then the built-in mastra-native
 * wrap. Fails closed with {@link GRAPH_MASTRA_MEMORY_UNAVAILABLE} when nothing
 * resolves — a wired memory provider must never silently vanish.
 *
 * @param options - The factory options (memory map and/or factory).
 * @param wiring - The memory provider nodes wired to the agent.
 * @returns The resolved live memories, in wiring order.
 * @throws {GraphExecutionError} when an entry resolves to nothing.
 */
async function resolveWiredMemories(
  options: MastraAgentFactoryOptions,
  wiring: readonly MastraAgentMemoryWiring[]
): Promise<unknown[]> {
  const resolved: unknown[] = [];
  for (const entry of wiring) {
    const keys = [entry.node.id, entry.config.id, entry.config.provider];
    let memory: unknown;
    if (options.memories) {
      for (const key of keys) {
        if (key && options.memories[key] !== undefined) {
          memory = options.memories[key];
          break;
        }
      }
    }
    if ((memory === undefined || memory === null) && options.createMemory) {
      memory = await options.createMemory(entry.config, entry.node);
    }
    if (memory === undefined || memory === null) {
      memory = (await resolveMastraMemory(entry.config)).memory;
    }
    if (memory === undefined || memory === null) {
      throw new GraphExecutionError(
        `Memory provider node '${entry.node.id}' wired to agent '${entry.node.id}' resolved no mastra memory`,
        GRAPH_MASTRA_MEMORY_UNAVAILABLE,
        { nodeId: entry.node.id, provider: entry.config.provider }
      );
    }
    resolved.push(memory);
  }
  return resolved;
}

/**
 * Builds mastra's per-run `memory` generate option (SAA-836 M2) from the
 * wiring: the first wired config with a `threadId` binds the invocation to
 * that thread (and resource id, when configured). Fails closed when the wired
 * memory declares no thread — mastra's `AgentMemoryOption` requires one, and a
 * thread-less memory binding would fabricate conversation semantics.
 *
 * @param wiring - The memory provider nodes wired to the agent.
 * @returns The generate `memory` option.
 * @throws {GraphExecutionError} when no wired memory configures a thread id.
 */
function memoryGenerateOptionOf(
  wiring: readonly MastraAgentMemoryWiring[]
): { thread: string; resource?: string } {
  for (const entry of wiring) {
    if (typeof entry.config.threadId === "string" && entry.config.threadId) {
      return entry.config.resourceId
        ? { thread: entry.config.threadId, resource: entry.config.resourceId }
        : { thread: entry.config.threadId };
    }
  }
  throw new GraphExecutionError(
    `Memory provider node '${wiring[0]?.node.id ?? ""}' wired to the agent declares no threadId, so the invocation cannot bind to a conversation thread`,
    GRAPH_MASTRA_MEMORY_UNAVAILABLE,
    { nodeId: wiring[0]?.node.id ?? "" }
  );
}

/**
 * Resolves the live agent for a node from the factory options.
 *
 * @param options - The factory options.
 * @param adapter - The node's validated model-adapter config, when present.
 * @param node - The canonical node instance.
 * @param memories - The live mastra memories resolved from the agent node's
 *   wired `memory` zone (SAA-836 M2), when any memory provider is connected.
 * @returns The live agent, or `undefined` when none can be resolved.
 */
async function resolveAgent(
  options: MastraAgentFactoryOptions,
  adapter: MastraModelAdapterConfig | undefined,
  node: GraphNodeInstance,
  memories?: readonly unknown[]
): Promise<unknown> {
  const agents = options.agents;
  if (agents) {
    const keys = [
      adapter ? `${adapter.provider}/${adapter.modelId}` : undefined,
      adapter?.modelId,
      node.id,
      node.kind,
    ];
    for (const key of keys) {
      if (key && agents[key] !== undefined) return agents[key];
    }
  }
  if (options.createAgent) {
    return options.createAgent(adapter, node, memories);
  }
  return undefined;
}

/**
 * Builds the config-backed {@link MastraAgentRuntime}: resolves the node's agent
 * and invokes it via `agent.generate(prompt, options)`, where the options carry
 * the caller's `abortSignal` plus the per-run mastra options the step resolved —
 * wired `inputProcessors`/`outputProcessors` overrides (SAA-836 M5), the wired
 * memory thread binding (SAA-836 M2), and the `structuredOutput` option
 * (SAA-836 S1) with the as-zod-derived Zod schema. The result is projected onto
 * the canonical outputs. Fails closed when the resolved agent is missing or
 * exposes no `generate` method.
 *
 * @param options - The named-agent map and/or agent factory.
 * @returns The runtime the agent step delegates to.
 */
export function createMastraAgentRuntimeFromConfig(
  options: MastraAgentFactoryOptions = {}
): MastraAgentRuntime {
  return {
    async execute(node, inputData, signal, processors, memories, structuredOutput) {
      const adapter = graphModelAdapterOf(node);
      // SAA-836 M2: resolve the memories wired onto the agent's `memory` zone
      // before the agent itself, so a factory can attach them at construction.
      const wiredMemories =
        memories && memories.length
          ? await resolveWiredMemories(options, memories)
          : undefined;
      const agent = await resolveAgent(options, adapter, node, wiredMemories);
      if (agent === undefined || agent === null) {
        throw new GraphExecutionError(
          `No mastra agent is available for node '${node.id}' (kind '${node.kind}')`,
          GRAPH_MASTRA_AGENT_UNAVAILABLE,
          {
            nodeId: node.id,
            kind: node.kind,
            ...(adapter ? { model: mastraModelConfigOf(adapter).id } : {}),
          }
        );
      }
      const generate = (agent as { generate?: unknown }).generate;
      if (typeof generate !== "function") {
        throw new GraphExecutionError(
          `Resolved mastra agent for node '${node.id}' exposes no generate method`,
          GRAPH_MASTRA_AGENT_UNAVAILABLE,
          { nodeId: node.id, kind: node.kind }
        );
      }
      const prompt = promptOf(node, inputData);
      const generateOptions: {
        abortSignal?: AbortSignal;
        inputProcessors?: unknown[];
        outputProcessors?: unknown[];
        memory?: { thread: string; resource?: string };
        structuredOutput?: {
          schema: unknown;
          instructions?: string;
          jsonPromptInjection?: boolean | "system" | "inline" | "auto";
          providerOptions?: Record<string, unknown>;
        };
      } = signal ? { abortSignal: signal } : {};
      if (processors?.inputProcessors.length) {
        generateOptions.inputProcessors = processors.inputProcessors;
      }
      if (processors?.outputProcessors.length) {
        generateOptions.outputProcessors = processors.outputProcessors;
      }
      // SAA-836 M2: bind the invocation to the wired memory's conversation
      // thread (mastra's per-run `memory` option) so conversation history,
      // semantic recall, and working memory apply to the generate call.
      if (memories && memories.length) {
        generateOptions.memory = memoryGenerateOptionOf(memories);
      }
      // SAA-836 S1: apply the node's resolved structured-output definition as
      // mastra's per-run `structuredOutput` option — the decaf-model-derived
      // Zod schema (via @decaf-ts/as-zod) drives and validates the response.
      if (structuredOutput) {
        generateOptions.structuredOutput = {
          schema: structuredOutput.schema,
          ...(structuredOutput.instructions !== undefined
            ? { instructions: structuredOutput.instructions }
            : {}),
          ...(structuredOutput.jsonPromptInjection !== undefined
            ? { jsonPromptInjection: structuredOutput.jsonPromptInjection }
            : {}),
          ...(structuredOutput.providerOptions !== undefined
            ? { providerOptions: structuredOutput.providerOptions }
            : {}),
        };
      }
      const result = await (
        generate as (
          prompt: string,
          options?: typeof generateOptions
        ) => unknown
      ).call(agent, prompt, Object.keys(generateOptions).length ? generateOptions : undefined);
      return agentOutputOf(result);
    },
  };
}

/**
 * Builds the schema-agnostic {@link MastraNodeStepHandler} registered for the
 * `core.agent` kind. The step coerces the runtime's input data to a record,
 * delegates to the configured runtime, and coerces the result back to a record
 * so untyped document parameters never break the mastra runtime.
 *
 * @param options - The handler-set options (the agent runtime).
 * @returns The `core.agent` step handler.
 */
export function createMastraAgentStepHandler(
  options: MastraAgentStepHandlerOptions = {}
): MastraNodeStepHandler {
  return {
    kind: "core.agent",
    createStep: (node: GraphNodeInstance, stepOptions: MastraNodeStepOptions) => {
      const document = stepOptions.document;
      // Resolved wired processors, memoized per step. Each compilation creates
      // fresh steps through this handler, so a per-step memo can never serve a
      // stale pipeline from a prior document revision.
      let wiredProcessors: MastraAgentWiredProcessors | undefined;
      // Resolved wired memory provider nodes (SAA-836 M2), memoized per step
      // with the same per-compilation freshness guarantee.
      let wiredMemories: readonly MastraAgentMemoryWiring[] | undefined;
      // Resolved structured-output option (SAA-836 S1), memoized per step;
      // a declared definition that cannot resolve fails closed at compile
      // time, never at run time.
      let structuredOutput: MastraResolvedStructuredOutput | undefined;
      let structuredOutputResolved = false;
      return createStep({
        id: stepOptions.stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: {
          inputData?: unknown;
          abortSignal?: AbortSignal;
        }) => {
          const inputData =
            args.inputData &&
            typeof args.inputData === "object" &&
            !Array.isArray(args.inputData)
              ? (args.inputData as Record<string, unknown>)
              : {};
          const runtime = options.runtime;
          if (!runtime) {
            throw new GraphExecutionError(
              `core.agent node '${node.id}' has no mastra agent runtime configured`,
              GRAPH_MASTRA_AGENT_UNAVAILABLE,
              { nodeId: node.id, kind: node.kind }
            );
          }
          // SAA-836 M5: resolve the processors wired onto the agent node's
          // `inputProcessors`/`outputProcessors` zones (memoized per step) and
          // hand them to the runtime as mastra's per-run processor overrides.
          let processors: MastraAgentWiredProcessors | undefined;
          if (document) {
            if (wiredProcessors) {
              processors = wiredProcessors;
            } else {
              processors = await resolveAgentWiredProcessors(
                document,
                node.id,
                options.resolveProcessorModel
              );
              wiredProcessors = processors;
            }
          }
          // SAA-836 M2: resolve the memory provider nodes wired onto the
          // agent's `memory` zone (memoized per step) and hand them to the
          // runtime, which resolves live mastra memories and binds the thread.
          let memories: readonly MastraAgentMemoryWiring[] | undefined;
          if (document) {
            const wiring =
              wiredMemories ??
              (wiredMemories = connectedMastraMemoryWiringOf(document, node));
            if (wiring.length) memories = wiring;
          }
          // SAA-836 S1: resolve the node's structured-output definition into
          // the mastra generate option (memoized per step). A declared
          // definition that cannot resolve fails closed here.
          if (!structuredOutputResolved) {
            structuredOutput = mastraStructuredOutputOf(node, options.resolveModel);
            structuredOutputResolved = true;
          }
          const output = await runtime.execute(
            node,
            inputData,
            args.abortSignal,
            processors,
            memories,
            structuredOutput
          );
          return output && typeof output === "object"
            ? (output as Record<string, unknown>)
            : {};
        },
      });
    },
  };
}
