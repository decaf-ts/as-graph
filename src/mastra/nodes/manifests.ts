/**
 * @module as-graph/mastra/nodes/manifests
 * @summary Mastra-owned node manifests (SAA-1545 §2.1).
 * @description Catalogue-published manifests for every node kind the Mastra
 * engine owns, derived at runtime from the Mastra-owned `@node`-decorated
 * classes. Kept separate from `src/node/manifests.ts` so the engine-neutral
 * catalogue never imports a Mastra node class.
 */
import type { GraphNodeManifest } from "../../shared/graph";
import { compile, compileWithIcon } from "../../node/manifest-compile";
import { AgentNode } from "./agent/node";
import { AgentToolNode } from "./tools/tool/node";
import { AgentToolSelectorNode } from "./tools/tool-selector/node";
import { AgentHookNode } from "./hooks/hook/node";
import { AgentToolDenyNode } from "./hooks/tool-deny/node";
import { AgentDelegationHookNode } from "./hooks/delegation/node";
import { AgentSkillNode } from "./skills/skill/node";
import { AgentSkillSelectorNode } from "./skills/skill-selector/node";
import { AgentSandboxNode } from "./sandbox/node";
import { AgentScorerNode } from "./scorers/scorer/node";
import { AgentScorerSelectorNode } from "./scorers/scorer-selector/node";
import { AgentMemoryNode } from "./memory/memory/node";
import { AgentMemorySelectorNode } from "./memory/memory-selector/node";
import { AgentEmbeddingNode } from "./rag/embedding/node";
import { AgentVectorStoreNode } from "./rag/vector-store/node";
import { AgentRetrieverNode } from "./rag/retriever/node";
import { AgentChunkingNode } from "./rag/chunking/node";
import { AgentRerankNode } from "./rag/rerank/node";
import { AgentQaChainNode } from "./rag/chains/qa/node";
import { AgentBasicChainNode } from "./rag/chains/basic/node";
import { AgentSummarizationChainNode } from "./rag/chains/summarization/node";
import { AgentStructuredOutputParserNode } from "./rag/structured-output-parser/node";
import { AgentInformationExtractorNode } from "./rag/information-extractor/node";
import { AgentLangChainCodeNode } from "./rag/langchain-code/node";
import { AgentInputProcessorNode } from "./processors/input-processor/node";
import { AgentOutputProcessorNode } from "./processors/output-processor/node";
import { AgentGuardrailNode } from "./processors/guardrail/node";
import { AgentHitlNode } from "./hitl/node";
import { McpServerTriggerNode } from "./triggers/mcp-server/node";
import { SlackChannelTriggerNode } from "./triggers/slack/node";
import { DiscordChannelTriggerNode } from "./triggers/discord/node";
import { TelegramChannelTriggerNode } from "./triggers/telegram/node";
import { TeamsChannelTriggerNode } from "./triggers/teams/node";
import { SlackChannelResponseNode } from "./responses/slack/node";
import { DiscordChannelResponseNode } from "./responses/discord/node";
import { TelegramChannelResponseNode } from "./responses/telegram/node";
import { TeamsChannelResponseNode } from "./responses/teams/node";
import { AgentVoiceNode } from "./voice/node";

/** All Mastra node manifests, in catalogue display order. */
export const MASTRA_NODE_MANIFESTS: GraphNodeManifest[] = [
  compile(AgentNode),
  compile(AgentToolNode),
  compile(AgentToolSelectorNode),
  compile(AgentHookNode),
  compile(AgentToolDenyNode),
  compile(AgentDelegationHookNode),
  compile(AgentSkillNode),
  compile(AgentSkillSelectorNode),
  compile(AgentSandboxNode),
  compile(AgentScorerNode),
  compile(AgentScorerSelectorNode),
  compile(AgentMemoryNode),
  compile(AgentMemorySelectorNode),
  compile(AgentEmbeddingNode),
  compile(AgentVectorStoreNode),
  compile(AgentRetrieverNode),
  compile(AgentChunkingNode),
  compile(AgentRerankNode),
  compile(AgentQaChainNode),
  compile(AgentBasicChainNode),
  compile(AgentSummarizationChainNode),
  compile(AgentStructuredOutputParserNode),
  compile(AgentInformationExtractorNode),
  compile(AgentLangChainCodeNode),
  compile(AgentInputProcessorNode),
  compile(AgentOutputProcessorNode),
  compile(AgentGuardrailNode),
  compile(AgentHitlNode),
  compile(McpServerTriggerNode),
  compileWithIcon(SlackChannelTriggerNode, "ti-brand-slack"),
  compileWithIcon(DiscordChannelTriggerNode, "ti-brand-discord"),
  compileWithIcon(TelegramChannelTriggerNode, "ti-brand-telegram"),
  compileWithIcon(TeamsChannelTriggerNode, "ti-brand-teams"),
  compileWithIcon(SlackChannelResponseNode, "ti-brand-slack"),
  compileWithIcon(DiscordChannelResponseNode, "ti-brand-discord"),
  compileWithIcon(TelegramChannelResponseNode, "ti-brand-telegram"),
  compileWithIcon(TeamsChannelResponseNode, "ti-brand-teams"),
  compileWithIcon(AgentVoiceNode, "ti-volume-2"),
];

/** Mastra node manifests indexed by kind. */
export const MASTRA_NODE_MANIFESTS_BY_KIND: Record<string, GraphNodeManifest> =
  Object.fromEntries(
    MASTRA_NODE_MANIFESTS.map((manifest) => [manifest.kind, manifest])
  );
