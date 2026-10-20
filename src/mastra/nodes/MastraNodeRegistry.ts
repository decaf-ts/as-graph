/**
 * @module as-graph/mastra/nodes/MastraNodeRegistry
 * @summary Built-in mastra implementation registry for node kinds (DECAF-809 Phase B).
 * @description Single authority binding every mastra-only node kind
 * (`core.agent` and its family — see `graphNodeRequiresMastraEngine`) to its
 * built-in `GraphNode` class and to the mastra step handlers that execute it.
 * The backend pulls its handler set from here instead of hand-wiring each
 * kind, and `auditMastraNodeCoverage`/`assertMastraNodeCoverage` fail closed
 * when a registered mastra-only kind lacks an implementation or a node class,
 * so a gap surfaces as `GRAPH_MASTRA_NODE_KIND_UNIMPLEMENTED` rather than a
 * fabricated placeholder step.
 */
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
import {
  graphNodeRequiresMastraEngine,
} from "../../engine/execution/GraphNodeEngineRequirements";
import { createMastraAgentStepHandler } from "../MastraAgentStepHandler";
import {
  createMastraChannelResponseStepHandlers,
} from "../MastraChannelResponse";
import {
  createMastraChannelTriggerStepHandlers,
} from "../MastraChannelTrigger";
import {
  createMastraDefaultStepHandlers,
} from "../MastraDefaultStepHandlers";
import { createMastraHitlStepHandler } from "../MastraHitlStepHandler";
import { createMastraMcpTriggerStepHandler } from "../MastraMcpTrigger";
import { createMastraRagStepHandlers } from "../MastraRagStepHandlers";
import { createMastraVoiceStepHandler } from "../MastraVoiceStepHandler";
import type { MastraNodeStepHandler } from "../types";
import { GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND } from "../../node";

import { AgentNode } from "../../node/agents/agent/node";
import { AgentDelegationHookNode } from "../../node/agents/hooks/delegation/node";
import { AgentHookNode } from "../../node/agents/hooks/hook/node";
import { AgentToolDenyNode } from "../../node/agents/hooks/tool-deny/node";
import { AgentHitlNode } from "../../node/agents/hitl/node";
import { AgentMemorySelectorNode } from "../../node/agents/memory/memory-selector/node";
import { AgentMemoryNode } from "../../node/agents/memory/memory/node";
import { AgentGuardrailNode } from "../../node/agents/processors/guardrail/node";
import { AgentInputProcessorNode } from "../../node/agents/processors/input-processor/node";
import { AgentOutputProcessorNode } from "../../node/agents/processors/output-processor/node";
import { AgentBasicChainNode } from "../../node/agents/rag/chains/basic/node";
import { AgentQaChainNode } from "../../node/agents/rag/chains/qa/node";
import { AgentSummarizationChainNode } from "../../node/agents/rag/chains/summarization/node";
import { AgentChunkingNode } from "../../node/agents/rag/chunking/node";
import { AgentEmbeddingNode } from "../../node/agents/rag/embedding/node";
import { AgentInformationExtractorNode } from "../../node/agents/rag/information-extractor/node";
import { AgentLangChainCodeNode } from "../../node/agents/rag/langchain-code/node";
import { AgentRerankNode } from "../../node/agents/rag/rerank/node";
import { AgentRetrieverNode } from "../../node/agents/rag/retriever/node";
import { AgentStructuredOutputParserNode } from "../../node/agents/rag/structured-output-parser/node";
import { AgentVectorStoreNode } from "../../node/agents/rag/vector-store/node";
import { DiscordChannelResponseNode } from "../../node/agents/responses/discord/node";
import { SlackChannelResponseNode } from "../../node/agents/responses/slack/node";
import { TeamsChannelResponseNode } from "../../node/agents/responses/teams/node";
import { TelegramChannelResponseNode } from "../../node/agents/responses/telegram/node";
import { AgentSandboxNode } from "../../node/agents/sandbox/node";
import { AgentScorerSelectorNode } from "../../node/agents/scorers/scorer-selector/node";
import { AgentScorerNode } from "../../node/agents/scorers/scorer/node";
import { AgentSkillSelectorNode } from "../../node/agents/skills/skill-selector/node";
import { AgentSkillNode } from "../../node/agents/skills/skill/node";
import { AgentToolSelectorNode } from "../../node/agents/tools/tool-selector/node";
import { AgentToolNode } from "../../node/agents/tools/tool/node";
import { DiscordChannelTriggerNode } from "../../node/agents/triggers/discord/node";
import { McpServerTriggerNode } from "../../node/agents/triggers/mcp-server/node";
import { SlackChannelTriggerNode } from "../../node/agents/triggers/slack/node";
import { TeamsChannelTriggerNode } from "../../node/agents/triggers/teams/node";
import { TelegramChannelTriggerNode } from "../../node/agents/triggers/telegram/node";
import { AgentVoiceNode } from "../../node/agents/voice/node";
import type {
  MastraNodeCoverageGap,
  MastraNodeHandlerOptions,
  MastraNodeKindImplementation,
} from "./types";

/** Built-in node classes by node kind, keyed by the kind discriminator. */
const NODE_CLASSES: Record<string, MastraNodeKindImplementation["nodeClass"]> = {
  "core.agent": AgentNode,
  "core.agent.tool": AgentToolNode,
  "core.agent.toolSelector": AgentToolSelectorNode,
  "core.agent.hook": AgentHookNode,
  "core.agent.toolDeny": AgentToolDenyNode,
  "core.agent.delegationHook": AgentDelegationHookNode,
  "core.agent.skill": AgentSkillNode,
  "core.agent.skillSelector": AgentSkillSelectorNode,
  "core.agent.sandbox": AgentSandboxNode,
  "core.agent.scorer": AgentScorerNode,
  "core.agent.scorerSelector": AgentScorerSelectorNode,
  "core.agent.memory": AgentMemoryNode,
  "core.agent.memorySelector": AgentMemorySelectorNode,
  "core.agent.embedding": AgentEmbeddingNode,
  "core.agent.vectorStore": AgentVectorStoreNode,
  "core.agent.retriever": AgentRetrieverNode,
  "core.agent.chunking": AgentChunkingNode,
  "core.agent.rerank": AgentRerankNode,
  "core.agent.chain.qa": AgentQaChainNode,
  "core.agent.chain.basic": AgentBasicChainNode,
  "core.agent.chain.summarization": AgentSummarizationChainNode,
  "core.agent.structuredOutputParser": AgentStructuredOutputParserNode,
  "core.agent.informationExtractor": AgentInformationExtractorNode,
  "core.agent.langchainCode": AgentLangChainCodeNode,
  "core.agent.inputProcessor": AgentInputProcessorNode,
  "core.agent.outputProcessor": AgentOutputProcessorNode,
  "core.agent.guardrail": AgentGuardrailNode,
  "core.agent.hitl": AgentHitlNode,
  "core.agent.trigger.mcp": McpServerTriggerNode,
  "core.agent.trigger.slack": SlackChannelTriggerNode,
  "core.agent.trigger.discord": DiscordChannelTriggerNode,
  "core.agent.trigger.telegram": TelegramChannelTriggerNode,
  "core.agent.trigger.teams": TeamsChannelTriggerNode,
  "core.agent.response.slack": SlackChannelResponseNode,
  "core.agent.response.discord": DiscordChannelResponseNode,
  "core.agent.response.telegram": TelegramChannelResponseNode,
  "core.agent.response.teams": TeamsChannelResponseNode,
  "core.agent.voice": AgentVoiceNode,
};

/** A step-handler factory entry contributing the handlers of one options group. */
interface HandlerGroup {
  create: (options: MastraNodeHandlerOptions) => MastraNodeStepHandler[];
}

/** Handler groups in registration order: defaults, agent, HITL, MCP trigger, channel trigger/response, voice, RAG. */
const HANDLER_GROUPS: readonly HandlerGroup[] = [
  { create: (options) => createMastraDefaultStepHandlers(options.default) },
  { create: (options) => [createMastraAgentStepHandler(options.agent)] },
  { create: () => [createMastraHitlStepHandler()] },
  { create: (options) => [createMastraMcpTriggerStepHandler(options.mcp)] },
  {
    create: (options) =>
      createMastraChannelTriggerStepHandlers(options.channelTrigger),
  },
  {
    create: (options) =>
      createMastraChannelResponseStepHandlers(options.channelResponse),
  },
  { create: (options) => [createMastraVoiceStepHandler(options.voice)] },
  { create: (options) => createMastraRagStepHandlers(options.rag) },
];

/**
 * Indexes every mastra-only kind produced with empty options to the handler
 * group that owns it, so implementations can be built per group.
 *
 * @returns A map from node kind to the index of its handler group in `HANDLER_GROUPS`.
 */
function kindGroupIndex(): Map<string, number> {
  const groups = new Map<string, number>();
  HANDLER_GROUPS.forEach((group, index) => {
    for (const handler of group.create({})) {
      groups.set(handler.kind, index);
    }
  });
  return groups;
}

/**
 * Builds one implementation per mastra-only kind: kinds are filtered to the
 * mastra engine boundary, sorted for deterministic ordering, and each factory
 * is narrowed to emit only the handlers of the kind it was indexed for.
 *
 * @returns The complete implementation list, ordered by kind.
 */
function buildImplementations(): MastraNodeKindImplementation[] {
  const groups = kindGroupIndex();
  return [...groups.entries()]
    .filter(([kind]) => graphNodeRequiresMastraEngine(kind))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, groupIndex]) => ({
      kind,
      nodeClass: NODE_CLASSES[kind],
      createStepHandlers: (options) =>
        HANDLER_GROUPS[groupIndex].create(options).filter(
          (handler) => handler.kind === kind
        ),
    }));
}

/**
 * Every mastra-only node kind with its built-in implementation, ordered by kind.
 * `nodeClass` may be `undefined` on an implementation whose handlers exist but
 * whose node class is not registered — such a gap is only observable through
 * {@link auditMastraNodeCoverage}.
 */
export const MASTRA_NODE_IMPLEMENTATIONS: readonly MastraNodeKindImplementation[] =
  buildImplementations();

/** The kinds of {@link MASTRA_NODE_IMPLEMENTATIONS}, ordered the same way. */
export const MASTRA_ONLY_NODE_KINDS: readonly string[] =
  MASTRA_NODE_IMPLEMENTATIONS.map((implementation) => implementation.kind);

/** Lookup from node kind to its mastra implementation. */
export const MASTRA_NODE_IMPLEMENTATION_BY_KIND: ReadonlyMap<
  string,
  MastraNodeKindImplementation
> = new Map(
  MASTRA_NODE_IMPLEMENTATIONS.map((implementation) => [
    implementation.kind,
    implementation,
  ])
);

/**
 * Produces the complete set of mastra step handlers the backend registers,
 * one per mastra-only kind, deduplicated by kind.
 *
 * The backend passes its host-supplied extension points (agent runtime,
 * MCP server factory, channel adapters, voice resolver, RAG embedders/vector
 * stores) through `options`; handler factories that receive nothing fail
 * closed for kinds that require those surfaces.
 *
 * @param options - Options forwarded to each handler group's factory.
 * @returns The deduplicated step handlers for all mastra-only kinds.
 */
export function createMastraNodeStepHandlers(
  options: MastraNodeHandlerOptions = {}
): MastraNodeStepHandler[] {
  const handlers = new Map<string, MastraNodeStepHandler>();
  for (const group of HANDLER_GROUPS) {
    for (const handler of group.create(options)) {
      if (!graphNodeRequiresMastraEngine(handler.kind)) continue;
      handlers.set(handler.kind, handler);
    }
  }
  return [...handlers.values()];
}

/**
 * Audits the given (default: every registered mastra-only) kind list for
 * implementations missing from the registry.
 *
 * @param kinds - Node kinds to audit; defaults to all mastra-only kinds in the built-in node catalogue.
 * @returns One gap per kind that has no implementation or no node class; empty when coverage is complete.
 */
export function auditMastraNodeCoverage(
  kinds: readonly string[] = Object.keys(
    GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND
  ).filter(graphNodeRequiresMastraEngine)
): MastraNodeCoverageGap[] {
  const gaps: MastraNodeCoverageGap[] = [];
  for (const kind of kinds) {
    if (!graphNodeRequiresMastraEngine(kind)) continue;
    const implementation = MASTRA_NODE_IMPLEMENTATION_BY_KIND.get(kind);
    if (!implementation) {
      gaps.push({ kind, reason: "missing-implementation" });
      continue;
    }
    if (!implementation.nodeClass) {
      gaps.push({ kind, reason: "missing-node-class" });
    }
  }
  return gaps;
}

/**
 * Asserts complete mastra node-kind coverage, throwing instead of returning gaps.
 *
 * @param kinds - Node kinds to audit; defaults to all mastra-only kinds in the built-in node catalogue.
 * @throws {GraphExecutionError} with code `GRAPH_MASTRA_NODE_KIND_UNIMPLEMENTED` listing every uncovered kind and reason.
 */
export function assertMastraNodeCoverage(
  kinds?: readonly string[]
): void {
  const gaps = auditMastraNodeCoverage(kinds);
  if (gaps.length > 0) {
    throw new GraphExecutionError(
      `Mastra node registry does not implement: ${gaps
        .map((gap) => `${gap.kind} (${gap.reason})`)
        .join(", ")}`,
      "GRAPH_MASTRA_NODE_KIND_UNIMPLEMENTED",
      { gaps }
    );
  }
}
