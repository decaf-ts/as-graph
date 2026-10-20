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
 * processor. `modelSelection` is stricter: mastra's `Classifier` validates a
 * structural decision model, so it requires the host `resolveProcessorModel`
 * hook and fails closed with the same code rather than forwarding a language
 * model id. Unknown processor/guardrail types fail closed the same way.
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
  BatchPartsProcessor,
  CyberRefusalHandler,
  LanguageDetector,
  ModelSelectionProcessor,
  ModerationProcessor,
  PIIDetector,
  PrefillErrorHandler,
  PromptInjectionDetector,
  ProviderHistoryCompat,
  RegexFilterProcessor,
  ResponseCache,
  StreamErrorRetryProcessor,
  SystemPromptScrubber,
  TokenCostControl,
  TokenLimiterProcessor,
  ToolCallFilter,
  UnicodeNormalizer,
  UnsupportedFileHandler,
} from "@mastra/core/processors";
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  graphModelAdapterOf,
  isMastraModelAdapterConfig,
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
 * Resolves the **decision** model a `modelSelection` classifier runs on.
 *
 * Mastra's `Classifier` validates its model structurally (it reads
 * `supportedQuestionTypes` and calls `doDecide`/`doEvaluate`), so the composed
 * `<provider>/<modelId>` language-model id is not a usable classifier model.
 * Only a host `resolveProcessorModel` can produce one; without it the node
 * fails closed with {@link GRAPH_MASTRA_PROCESSOR_UNAVAILABLE} instead of
 * letting mastra throw a raw `TypeError`.
 *
 * @param adapter - The wired node's model-adapter config (R1), when present.
 * @param resolveModel - The host resolver, when supplied.
 * @param nodeId - The wired node id (error details).
 * @returns The resolved mastra decision model.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_PROCESSOR_UNAVAILABLE} when
 *   no host resolver yields a decision model.
 */
async function classifierModelOf(
  adapter: MastraModelAdapterConfig | undefined,
  resolveModel: MastraProcessorModelResolver | undefined,
  nodeId: string
): Promise<unknown> {
  if (resolveModel) {
    const resolved = await resolveModel(adapter);
    if (resolved !== undefined && resolved !== null) return resolved;
  }
  throw new GraphExecutionError(
    `Model-selection processor node '${nodeId}' requires a classifier decision model from the host 'resolveProcessorModel' hook; a language-model id cannot serve as a mastra classifier model`,
    GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
    { nodeId, processorType: "modelSelection" }
  );
}

/**
 * Refuses options for a mastra processor variant whose constructor takes none:
 * the node vocabulary is JSON config only, so an options object on a
 * no-options variant is a configuration mistake rather than something to
 * silently ignore.
 *
 * @param options - The node's processor options.
 * @param nodeId - The wired node id (error details).
 * @param processorType - The variant discriminator (error details).
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_PROCESSOR_UNAVAILABLE} when
 *   options are present.
 */
function assertNoProcessorOptions(
  options: Record<string, unknown>,
  nodeId: string,
  processorType: string
): void {
  if (Object.keys(options).length > 0) {
    throw new GraphExecutionError(
      `Processor node '${nodeId}' declares options for '${processorType}', which takes no configuration`,
      GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
      { nodeId, processorType }
    );
  }
}

/**
 * Resolves the `modelSelection` processor's per-choice model adapters (R1) into
 * the mastra selectable model values. Every choice must name its criteria and a
 * model adapter; the host resolver, when supplied, maps the adapter to a live
 * model, otherwise the composed `<provider>/<modelId>` id is used. The
 * classifier's own **decision** model must come from the host resolver (see
 * {@link classifierModelOf}) because mastra validates its structure.
 *
 * @param options - The node's processor options (`choices` is required).
 * @param node - The wired processor node (id and error details).
 * @param adapter - The node's classifier model adapter (R1).
 * @param resolveModel - The host model resolver, when supplied.
 * @returns The options with `choices[].model` resolved and `modelAdapter` removed.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_PROCESSOR_UNAVAILABLE} when
 *   a choice is malformed or its model cannot be resolved, or when the
 *   classifier decision model is unavailable.
 */
async function modelSelectionOptionsOf(
  options: Record<string, unknown>,
  node: GraphNodeInstance,
  adapter: MastraModelAdapterConfig | undefined,
  resolveModel?: MastraProcessorModelResolver
): Promise<Record<string, unknown>> {
  const choices = options["choices"];
  if (!Array.isArray(choices) || choices.length < 2) {
    throw new GraphExecutionError(
      `Model-selection processor node '${node.id}' requires at least two 'choices' to route between`,
      GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
      { nodeId: node.id, processorType: "modelSelection" }
    );
  }
  const resolvedChoices: Array<Record<string, unknown>> = [];
  for (const [index, choice] of choices.entries()) {
    if (!isRecord(choice)) {
      throw new GraphExecutionError(
        `Model-selection choice ${index} on node '${node.id}' is not an object`,
        GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
        { nodeId: node.id, choiceIndex: index }
      );
    }
    const criteria = choice["criteria"];
    if (typeof criteria !== "string" || criteria.trim().length === 0) {
      throw new GraphExecutionError(
        `Model-selection choice ${index} on node '${node.id}' requires non-empty 'criteria'`,
        GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
        { nodeId: node.id, choiceIndex: index }
      );
    }
    const adapterValue = choice["modelAdapter"];
    if (!isMastraModelAdapterConfig(adapterValue)) {
      throw new GraphExecutionError(
        `Model-selection choice ${index} on node '${node.id}' requires a valid 'modelAdapter' config (provider and modelId)`,
        GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
        { nodeId: node.id, choiceIndex: index }
      );
    }
    const model = await processorModelOf(adapterValue, resolveModel, node.id);
    resolvedChoices.push({
      model,
      criteria,
      ...(typeof choice["name"] === "string" ? { name: choice["name"] } : {}),
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { choices: _choices, ...rest } = options;
  const model = await classifierModelOf(adapter, resolveModel, node.id);
  return { ...rest, model, choices: resolvedChoices };
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
        !(MASTRA_INPUT_PROCESSOR_TYPES as readonly string[]).includes(
          processorType
        )
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
            model: (await processorModelOf(
              adapter,
              resolveModel,
              node.id
            )) as never,
          } as never);
        case "languageDetector":
          return new LanguageDetector({
            ...options,
            model: (await processorModelOf(
              adapter,
              resolveModel,
              node.id
            )) as never,
          } as never);
        case "piiDetector":
          return new PIIDetector({
            ...options,
            model: (await processorModelOf(
              adapter,
              resolveModel,
              node.id
            )) as never,
          } as never);
        case "promptInjectionDetector":
          return new PromptInjectionDetector({
            ...options,
            model: (await processorModelOf(
              adapter,
              resolveModel,
              node.id
            )) as never,
          } as never);
        case "tokenCostControl": {
          const maxCost = options["maxCost"];
          if (
            typeof maxCost !== "number" ||
            !Number.isFinite(maxCost) ||
            maxCost <= 0
          ) {
            throw new GraphExecutionError(
              `Token-cost-control processor node '${node.id}' requires a positive numeric 'options.maxCost' budget`,
              GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
              { nodeId: node.id, processorType }
            );
          }
          return new TokenCostControl(options as never);
        }
        case "modelSelection":
          return new ModelSelectionProcessor(
            (await modelSelectionOptionsOf(
              options,
              node,
              adapter,
              resolveModel
            )) as never
          );
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
        !(MASTRA_OUTPUT_PROCESSOR_TYPES as readonly string[]).includes(
          processorType
        )
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
          return new RegexFilterProcessor(
            regexRulesOf(options, node.id) as never
          );
        case "responseCache":
          return new ResponseCache(options as never);
        case "batchParts":
          return new BatchPartsProcessor(options as never);
        case "providerHistoryCompat": {
          if (options["additionalRules"] !== undefined) {
            throw new GraphExecutionError(
              `Provider-history-compat processor node '${node.id}' cannot carry 'additionalRules': compatibility rules contain functions and regexes that are not JSON-serializable (built-in mastra rules remain active)`,
              GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
              { nodeId: node.id, processorType }
            );
          }
          assertNoProcessorOptions(options, node.id, processorType);
          return new ProviderHistoryCompat();
        }
        case "cyberRefusalHandler":
          assertNoProcessorOptions(options, node.id, processorType);
          return new CyberRefusalHandler();
        case "prefillErrorHandler":
          assertNoProcessorOptions(options, node.id, processorType);
          return new PrefillErrorHandler();
        case "unsupportedFileHandler":
          assertNoProcessorOptions(options, node.id, processorType);
          return new UnsupportedFileHandler();
        case "streamErrorRetry": {
          if (options["matchers"] !== undefined) {
            throw new GraphExecutionError(
              `Stream-error-retry processor node '${node.id}' cannot carry 'matchers': matcher predicates are not JSON-serializable (only the numeric/boolean retry knobs are supported)`,
              GRAPH_MASTRA_PROCESSOR_UNAVAILABLE,
              { nodeId: node.id, processorType }
            );
          }
          return new StreamErrorRetryProcessor(options as never);
        }
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
            model: (await processorModelOf(
              adapter,
              resolveModel,
              node.id
            )) as never,
          } as never);
        case "piiDetector":
          return new PIIDetector({
            ...options,
            model: (await processorModelOf(
              adapter,
              resolveModel,
              node.id
            )) as never,
          } as never);
        case "promptInjectionDetector":
          return new PromptInjectionDetector({
            ...options,
            model: (await processorModelOf(
              adapter,
              resolveModel,
              node.id
            )) as never,
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
