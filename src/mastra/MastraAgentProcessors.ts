/**
 * @module as-graph/mastra/MastraAgentProcessors
 * @summary Mastra processor/guardrail resolution for agent execution
 * (SAA-836 M5).
 * @description Resolves the processor and guardrail nodes wired onto an agent
 * node's `inputProcessors`/`outputProcessors` zones into the real
 * `@mastra/core/processors` instances mastra applies to agent execution as
 * per-run overrides (R3 — mastra's own processing pipeline). Input processors
 * map onto mastra's `inputProcessors`, output processors and guardrails onto
 * `outputProcessors` (guardrails compose with the output-processor pipeline).
 *
 * Resolution reads each wired node's **parameters** (the config-only path is
 * the primary carrier here, because connection edges are structural and never
 * route values); the node's own `resource` output descriptor remains the R9
 * resource-output shape for consumers that read it directly. Model-carrying
 * processor types (`languageDetector`, `piiDetector`,
 * `promptInjectionDetector`, `systemPromptScrubber`, `moderation`) take their
 * classifier as adapter-in-config (R1) — the host may supply a model resolver;
 * without one the composed `<provider>/<modelId>` id is used, and a
 * model-carrying type with no resolvable model fails closed with
 * {@link GRAPH_MASTRA_PROCESSOR_UNAVAILABLE} instead of fabricating a
 * processor. Unknown processor/guardrail types fail closed the same way.
 *
 * Regex-filter rules are normalized before construction: node parameters
 * arrive JSON-serialized, so a rule `pattern` given as a string is compiled
 * into a `RegExp` (with the rule's optional `flags`) — mastra's
 * `RegexFilterProcessor` only matches `RegExp` instances, and a raw string
 * would silently compile to an empty-match pattern. A pattern that is neither
 * a `RegExp` nor a string, or a string that does not compile, fails closed
 * with {@link GRAPH_MASTRA_PROCESSOR_UNAVAILABLE}.
 */
import {
  LanguageDetector,
  ModerationProcessor,
  PIIDetector,
  PromptInjectionDetector,
  RegexFilterProcessor,
  ResponseCache,
  SystemPromptScrubber,
  TokenLimiterProcessor,
  ToolCallFilter,
  UnicodeNormalizer,
} from "@mastra/core/processors";
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  graphModelAdapterOf,
  mastraModelConfigOf,
  type MastraModelAdapterConfig,
} from "./MastraAgentModelAdapter";
import { GRAPH_MASTRA_PROCESSOR_UNAVAILABLE } from "./types";
import {
  MASTRA_GUARDRAIL_TYPES,
  MASTRA_INPUT_PROCESSOR_TYPES,
  MASTRA_OUTPUT_PROCESSOR_TYPES,
} from "../node/agents/processors/types";

/** A document node kind the mastra processor resolution consumes. */
export const MASTRA_AGENT_PROCESSOR_KINDS = [
  "core.agent.inputProcessor",
  "core.agent.outputProcessor",
  "core.agent.guardrail",
] as const;

/** The mastra-native processor/guardrail types (mirrors the node vocabulary). */
export type {
  MastraGuardrailType,
  MastraInputProcessorType,
  MastraOutputProcessorType,
} from "../node/agents/processors/types";

/** The wired processor set an agent node's zones resolve to. */
export interface MastraAgentWiredProcessors {
  /** Mastra input processors applied as the per-run `inputProcessors` override. */
  inputProcessors: unknown[];
  /** Mastra output processors (incl. guardrails) applied as the per-run `outputProcessors` override. */
  outputProcessors: unknown[];
}

/**
 * Host hook resolving the classifier model a model-carrying processor type
 * runs on (R1 — adapter-in-config). Receives the wired node's validated
 * model-adapter config, when present. Returning `undefined` fails closed.
 */
export type MastraProcessorModelResolver = (
  adapter: MastraModelAdapterConfig | undefined
) => unknown | Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalizes regex-filter `options.rules` for mastra's `RegexFilterProcessor`:
 * a string rule `pattern` is compiled into a `RegExp` (mastra only matches
 * `RegExp` instances; a raw string would silently degrade to an empty-match
 * pattern), the optional `flags` string seeds the compilation and is not
 * forwarded. A pattern that is neither a `RegExp` nor a string, or a string
 * that does not compile, fails closed.
 *
 * @param options - The node's processor options.
 * @param nodeId - The wired node id (error details).
 * @returns The options with every rule `pattern` normalized to a `RegExp`.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_PROCESSOR_UNAVAILABLE} when
 *   a rule pattern is missing/ill-typed or does not compile.
 */
function regexRulesOf(
  options: Record<string, unknown>,
  nodeId: string
): Record<string, unknown> {
  if (!Array.isArray(options["rules"])) return options;
  const rules = options["rules"].map((rule, index) => {
    if (!isRecord(rule)) return rule;
    const pattern = rule["pattern"];
    if (pattern instanceof RegExp) return rule;
    if (typeof pattern !== "string") {
      throw new GraphExecutionError(
        `Regex-filter rule ${index} on node '${nodeId}' declares a pattern that is neither a RegExp nor a string`,
        GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
        { nodeId, ruleIndex: index }
      );
    }
    const flags = typeof rule["flags"] === "string" ? rule["flags"] : undefined;
    try {
      const normalized: Record<string, unknown> = { ...rule };
      delete normalized["flags"];
      normalized["pattern"] = new RegExp(pattern, flags);
      return normalized;
    } catch (error) {
      throw new GraphExecutionError(
        `Regex-filter rule ${index} on node '${nodeId}' declares an invalid pattern '${pattern}': ${String(error)}`,
        GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
        { nodeId, ruleIndex: index }
      );
    }
  });
  return { ...options, rules };
}

/**
 * Resolves the classifier model for a model-carrying processor type.
 *
 * @param adapter - The wired node's model-adapter config, when present.
 * @param resolveModel - The host resolver, when supplied.
 * @param nodeId - The wired node id (error details).
 * @returns The mastra model config the processor runs on.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_PROCESSOR_UNAVAILABLE} when
 *   the host resolver yields nothing and no adapter config can be composed.
 */
async function processorModelOf(
  adapter: MastraModelAdapterConfig | undefined,
  resolveModel: MastraProcessorModelResolver | undefined,
  nodeId: string
): Promise<unknown> {
  if (resolveModel) {
    const resolved = await resolveModel(adapter);
    if (resolved !== undefined && resolved !== null) return resolved;
  }
  if (adapter) return mastraModelConfigOf(adapter).id;
  throw new GraphExecutionError(
    `Processor node '${nodeId}' requires a classifier model, but no model adapter or host model resolver is available`,
    GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
    { nodeId }
  );
}

/**
 * Builds the real mastra processor instance one wired processor node resolves
 * to. The mapping is mastra-native (R3): every type names a real
 * `@mastra/core/processors` class and the node's `options` are forwarded
 * verbatim to its constructor; model-carrying types receive the resolved
 * classifier model.
 *
 * @param node - The wired processor/guardrail document node.
 * @param resolveModel - The host model resolver, when supplied.
 * @returns The mastra processor instance.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_PROCESSOR_UNAVAILABLE} when
 *   the node declares an unknown type or a model-carrying type without a
 *   resolvable model.
 */
export async function mastraProcessorInstanceOf(
  node: GraphNodeInstance,
  resolveModel?: MastraProcessorModelResolver
): Promise<unknown> {
  const parameters = node.parameters ?? {};
  const options = isRecord(parameters["options"]) ? parameters["options"] : {};
  const adapter = graphModelAdapterOf(node);
  switch (node.kind) {
    case "core.agent.inputProcessor": {
      const processorType = parameters["processorType"];
      if (
        typeof processorType !== "string" ||
        !(
          MASTRA_INPUT_PROCESSOR_TYPES as readonly string[]
        ).includes(processorType)
      ) {
        throw new GraphExecutionError(
          `Input-processor node '${node.id}' declares unknown processor type '${String(processorType)}'`,
          GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
          { nodeId: node.id, processorType }
        );
      }
      switch (processorType) {
        case "unicodeNormalizer":
          return new UnicodeNormalizer(options as never);
        case "systemPromptScrubber":
          return new SystemPromptScrubber({
            ...options,
            model: (await processorModelOf(adapter, resolveModel, node.id)) as never,
          } as never);
        case "languageDetector":
          return new LanguageDetector({
            ...options,
            model: (await processorModelOf(adapter, resolveModel, node.id)) as never,
          } as never);
        case "piiDetector":
          return new PIIDetector({
            ...options,
            model: (await processorModelOf(adapter, resolveModel, node.id)) as never,
          } as never);
        case "promptInjectionDetector":
          return new PromptInjectionDetector({
            ...options,
            model: (await processorModelOf(adapter, resolveModel, node.id)) as never,
          } as never);
        default:
          throw new GraphExecutionError(
            `Input-processor node '${node.id}' declares unhandled processor type '${processorType}'`,
            GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
            { nodeId: node.id, processorType }
          );
      }
    }
    case "core.agent.outputProcessor": {
      const processorType = parameters["processorType"];
      if (
        typeof processorType !== "string" ||
        !(
          MASTRA_OUTPUT_PROCESSOR_TYPES as readonly string[]
        ).includes(processorType)
      ) {
        throw new GraphExecutionError(
          `Output-processor node '${node.id}' declares unknown processor type '${String(processorType)}'`,
          GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
          { nodeId: node.id, processorType }
        );
      }
      switch (processorType) {
        case "tokenLimiter":
          return new TokenLimiterProcessor(options as never);
        case "toolCallFilter":
          return new ToolCallFilter(options as never);
        case "regexFilter":
          return new RegexFilterProcessor(regexRulesOf(options, node.id) as never);
        case "responseCache":
          return new ResponseCache(options as never);
        default:
          throw new GraphExecutionError(
            `Output-processor node '${node.id}' declares unhandled processor type '${processorType}'`,
            GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
            { nodeId: node.id, processorType }
          );
      }
    }
    case "core.agent.guardrail": {
      const guardrailType = parameters["guardrailType"];
      if (
        typeof guardrailType !== "string" ||
        !(MASTRA_GUARDRAIL_TYPES as readonly string[]).includes(guardrailType)
      ) {
        throw new GraphExecutionError(
          `Guardrail node '${node.id}' declares unknown guardrail type '${String(guardrailType)}'`,
          GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
          { nodeId: node.id, guardrailType }
        );
      }
      switch (guardrailType) {
        case "moderation":
          return new ModerationProcessor({
            ...options,
            model: (await processorModelOf(adapter, resolveModel, node.id)) as never,
          } as never);
        case "piiDetector":
          return new PIIDetector({
            ...options,
            model: (await processorModelOf(adapter, resolveModel, node.id)) as never,
          } as never);
        case "promptInjectionDetector":
          return new PromptInjectionDetector({
            ...options,
            model: (await processorModelOf(adapter, resolveModel, node.id)) as never,
          } as never);
        case "regexFilter":
          return new RegexFilterProcessor({
            ...regexRulesOf(options, node.id),
            ...(parameters["strategy"] !== undefined
              ? { strategy: parameters["strategy"] }
              : {}),
          } as never);
        default:
          throw new GraphExecutionError(
            `Guardrail node '${node.id}' declares unhandled guardrail type '${guardrailType}'`,
            GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
            { nodeId: node.id, guardrailType }
          );
      }
    }
    default:
      throw new GraphExecutionError(
        `Node '${node.id}' of kind '${node.kind}' is not a mastra processor kind`,
        GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
        { nodeId: node.id, kind: node.kind }
      );
  }
}

/**
 * Resolves the endpoint node id of a connection edge side.
 *
 * @param edge - The edge side to inspect.
 * @returns The node id when the endpoint is node-scoped, else `undefined`.
 */
function edgeEndpointNodeId(endpoint: {
  scope: string;
  nodeId?: string;
}): string | undefined {
  return endpoint.scope === "node" ? endpoint.nodeId : undefined;
}

/**
 * Resolves the processor and guardrail nodes wired onto one agent node's
 * `inputProcessors`/`outputProcessors` zones into the real mastra processor
 * instances. Connection edges are scanned in document order, so the resolved
 * processor order is deterministic; guardrail nodes compose with the output
 * processors on the `outputProcessors` zone. Nodes whose instance construction
 * fails propagate the fail-closed error — a wired but unresolvable processor
 * never silently disappears from the pipeline.
 *
 * @param document - The canonical document being compiled.
 * @param agentNodeId - The agent node id whose zones to resolve.
 * @param resolveModel - The host model resolver, when supplied.
 * @returns The wired mastra processor instances per pipeline.
 */
export async function resolveAgentWiredProcessors(
  document: GraphWorkflowDocument,
  agentNodeId: string,
  resolveModel?: MastraProcessorModelResolver
): Promise<MastraAgentWiredProcessors> {
  const wired: MastraAgentWiredProcessors = {
    inputProcessors: [],
    outputProcessors: [],
  };
  const nodesById = new Map(
    (document.nodes ?? []).map((node) => [node.id, node])
  );
  const processorKinds = new Set<string>(MASTRA_AGENT_PROCESSOR_KINDS);
  for (const edge of document.edges ?? []) {
    if (edge.type !== "connection") continue;
    const targetId = edgeEndpointNodeId(edge.target);
    if (targetId !== agentNodeId) continue;
    const sourceId = edgeEndpointNodeId(edge.source);
    if (!sourceId) continue;
    const source = nodesById.get(sourceId);
    if (!source || !processorKinds.has(source.kind)) continue;
    if (edge.target.port === "inputProcessors") {
      wired.inputProcessors.push(
        await mastraProcessorInstanceOf(source, resolveModel)
      );
    } else if (edge.target.port === "outputProcessors") {
      wired.outputProcessors.push(
        await mastraProcessorInstanceOf(source, resolveModel)
      );
    }
  }
  return wired;
}
