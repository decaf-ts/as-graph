/**
 * @module as-graph/mastra/nodes/classes
 * @summary Mastra-owned node classes, grouped by family and indexed by kind.
 * @description The single class registry for every node kind the Mastra engine
 * owns. The engine-neutral catalogue (`src/node`) must never import this module,
 * so the general engine and the shared/browser-safe surface stay free of
 * `@mastra/core` and Mastra node implementations.
 */
import type { GraphNodeClass } from "../../node/base";
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

/** All built-in Mastra tool family node constructors. */
export const MASTRA_AGENT_FAMILY_NODES = [
  AgentToolNode,
  AgentToolSelectorNode,
  AgentHookNode,
  AgentToolDenyNode,
  AgentDelegationHookNode,
  AgentSkillNode,
  AgentSkillSelectorNode,
  AgentSandboxNode,
  AgentScorerNode,
  AgentScorerSelectorNode,
] as const;

/** All built-in Mastra memory node constructors. */
export const MASTRA_AGENT_MEMORY_NODES = [
  AgentMemoryNode,
  AgentMemorySelectorNode,
] as const;

/** All built-in Mastra RAG node constructors. */
export const MASTRA_AGENT_RAG_NODES = [
  AgentEmbeddingNode,
  AgentVectorStoreNode,
  AgentRetrieverNode,
  AgentChunkingNode,
  AgentRerankNode,
  AgentQaChainNode,
  AgentBasicChainNode,
  AgentSummarizationChainNode,
  AgentStructuredOutputParserNode,
  AgentInformationExtractorNode,
  AgentLangChainCodeNode,
] as const;

/** All built-in Mastra processor node constructors. */
export const MASTRA_AGENT_PROCESSOR_NODES = [
  AgentInputProcessorNode,
  AgentOutputProcessorNode,
  AgentGuardrailNode,
] as const;

/** All built-in Mastra HITL and MCP-trigger node constructors. */
export const MASTRA_AGENT_M5_NODES = [AgentHitlNode, McpServerTriggerNode] as const;

/** All built-in Mastra channel/voice node constructors. */
export const MASTRA_AGENT_M6_NODES = [
  SlackChannelTriggerNode,
  DiscordChannelTriggerNode,
  TelegramChannelTriggerNode,
  TeamsChannelTriggerNode,
  SlackChannelResponseNode,
  DiscordChannelResponseNode,
  TelegramChannelResponseNode,
  TeamsChannelResponseNode,
  AgentVoiceNode,
] as const;

/**
 * Kind→class map for every Mastra-owned node kind. The Mastra node registry and
 * catalogue are derived from this single authority.
 */
export const MASTRA_NODE_CLASSES_BY_KIND: Record<string, GraphNodeClass> = {
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
