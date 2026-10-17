/**
 * @module as-graph/nodes
 * @summary Shared node kind declarations (DECAF-32 §22.2, DECAF-50 Phase A).
 * @description Canonical `@node`-decorated classes for the ALFRED-5 node kind
 * taxonomy, laid out one node per folder under
 * `node/<category>/<sub>/<node>/node.ts`: triggers (§22.2.1), flow-control and
 * utility nodes (§22.2.2–22.2.3), the Agent node (§21.3), the three loop kinds
 * (`core.loop.foreach/while/until`, §5.9), and the workflow input/output value
 * boundary nodes. Shared non-node support (the base class and manifests) lives in
 * sibling files under the same tree; category styles remain in
 * `@decaf-ts/ui-decorators` (`graph/category-styles`). Consumers
 * (for-angular, ALFRED, etc.) import these declarations to populate node
 * palettes, registries, and reference snapshots.
 */
export * from "./base";
export * from "./flow/break/node";
export * from "./flow/error-boundary/node";
export * from "./flow/human-approval/node";
export * from "./flow/if/node";
export * from "./flow/switch/node";
export * from "./utility/code/node";
export * from "./utility/delay/node";
export * from "./utility/log/node";
export * from "./utility/map/node";
export * from "./utility/utility-log/node";
export * from "./triggers/chat/node";
export * from "./triggers/event/node";
export * from "./triggers/form/node";
export * from "./triggers/manual/node";
export * from "./triggers/schedule/node";
export * from "./triggers/webhook/node";
export * from "./agents/agent/node";
export * from "./agents/zones";
export * from "./agents/tools/tool/node";
export * from "./agents/tools/tool-selector/node";
export * from "./agents/hooks/hook/node";
export * from "./agents/hooks/tool-deny/node";
export * from "./agents/hooks/delegation/node";
export * from "./agents/skills/skill/node";
export * from "./agents/skills/skill-selector/node";
export * from "./agents/sandbox/node";
export * from "./agents/scorers/scorer/node";
export * from "./agents/scorers/scorer-selector/node";
export * from "./agents/memory/memory/node";
export * from "./agents/memory/memory-selector/node";
export * from "./agents/rag/embedding/node";
export * from "./agents/rag/vector-store/node";
export * from "./agents/rag/retriever/node";
export * from "./agents/rag/chunking/node";
export * from "./agents/rag/rerank/node";
export * from "./agents/rag/chains/qa/node";
export * from "./agents/rag/chains/basic/node";
export * from "./agents/rag/chains/summarization/node";
export * from "./agents/rag/structured-output-parser/node";
export * from "./agents/rag/information-extractor/node";
export * from "./agents/rag/langchain-code/node";
export * from "./agents/processors/types";
export * from "./agents/processors/input-processor/node";
export * from "./agents/processors/output-processor/node";
export * from "./agents/processors/guardrail/node";
export * from "./agents/hitl/node";
export * from "./agents/triggers/mcp-server/node";
export * from "./agents/triggers/slack/node";
export * from "./agents/triggers/discord/node";
export * from "./agents/triggers/telegram/node";
export * from "./agents/triggers/teams/node";
export * from "./agents/responses/slack/node";
export * from "./agents/responses/discord/node";
export * from "./agents/responses/telegram/node";
export * from "./agents/responses/teams/node";
export * from "./agents/voice/node";
export * from "./flow/loop/foreach/node";
export * from "./flow/loop/until/node";
export * from "./flow/loop/while/node";
export * from "./boundary/input/node";
export * from "./boundary/output/node";
export * from "./manifests";
import type { GraphNodeClass } from "./base";

import { AgentNode } from "./agents/agent/node";
import { AgentToolNode } from "./agents/tools/tool/node";
import { AgentToolSelectorNode } from "./agents/tools/tool-selector/node";
import { AgentHookNode } from "./agents/hooks/hook/node";
import { AgentToolDenyNode } from "./agents/hooks/tool-deny/node";
import { AgentDelegationHookNode } from "./agents/hooks/delegation/node";
import { AgentSkillNode } from "./agents/skills/skill/node";
import { AgentSkillSelectorNode } from "./agents/skills/skill-selector/node";
import { AgentSandboxNode } from "./agents/sandbox/node";
import { AgentScorerNode } from "./agents/scorers/scorer/node";
import { AgentScorerSelectorNode } from "./agents/scorers/scorer-selector/node";
import { AgentMemoryNode } from "./agents/memory/memory/node";
import { AgentMemorySelectorNode } from "./agents/memory/memory-selector/node";
import { AgentEmbeddingNode } from "./agents/rag/embedding/node";
import { AgentVectorStoreNode } from "./agents/rag/vector-store/node";
import { AgentRetrieverNode } from "./agents/rag/retriever/node";
import { AgentChunkingNode } from "./agents/rag/chunking/node";
import { AgentRerankNode } from "./agents/rag/rerank/node";
import { AgentQaChainNode } from "./agents/rag/chains/qa/node";
import { AgentBasicChainNode } from "./agents/rag/chains/basic/node";
import { AgentSummarizationChainNode } from "./agents/rag/chains/summarization/node";
import { AgentStructuredOutputParserNode } from "./agents/rag/structured-output-parser/node";
import { AgentInformationExtractorNode } from "./agents/rag/information-extractor/node";
import { AgentLangChainCodeNode } from "./agents/rag/langchain-code/node";
import { AgentInputProcessorNode } from "./agents/processors/input-processor/node";
import { AgentOutputProcessorNode } from "./agents/processors/output-processor/node";
import { AgentGuardrailNode } from "./agents/processors/guardrail/node";
import { AgentHitlNode } from "./agents/hitl/node";
import { McpServerTriggerNode } from "./agents/triggers/mcp-server/node";
import { SlackChannelTriggerNode } from "./agents/triggers/slack/node";
import { DiscordChannelTriggerNode } from "./agents/triggers/discord/node";
import { TelegramChannelTriggerNode } from "./agents/triggers/telegram/node";
import { TeamsChannelTriggerNode } from "./agents/triggers/teams/node";
import { SlackChannelResponseNode } from "./agents/responses/slack/node";
import { DiscordChannelResponseNode } from "./agents/responses/discord/node";
import { TelegramChannelResponseNode } from "./agents/responses/telegram/node";
import { TeamsChannelResponseNode } from "./agents/responses/teams/node";
import { AgentVoiceNode } from "./agents/voice/node";
import { BreakFlowNode } from "./flow/break/node";
import { ErrorBoundaryFlowNode } from "./flow/error-boundary/node";
import { HumanApprovalFlowNode } from "./flow/human-approval/node";
import { IfFlowNode } from "./flow/if/node";
import { SwitchFlowNode } from "./flow/switch/node";
import { CodeNode } from "./utility/code/node";
import { DelayFlowNode } from "./utility/delay/node";
import { LogFlowNode } from "./utility/log/node";
import { MapNode } from "./utility/map/node";
import { UtilityLogNode } from "./utility/utility-log/node";
import { ChatTriggerNode } from "./triggers/chat/node";
import { EventTriggerNode } from "./triggers/event/node";
import { FormTriggerNode } from "./triggers/form/node";
import { ManualTriggerNode } from "./triggers/manual/node";
import { ScheduleTriggerNode } from "./triggers/schedule/node";
import { WebhookTriggerNode } from "./triggers/webhook/node";
import { GraphForeachLoopNode } from "./flow/loop/foreach/node";
import { GraphUntilLoopNode } from "./flow/loop/until/node";
import { GraphWhileLoopNode } from "./flow/loop/while/node";
import { GraphInputValueNode } from "./boundary/input/node";
import { GraphOutputValueNode } from "./boundary/output/node";

/**
 * All built-in trigger node constructors.
 */
export const GRAPH_TRIGGER_NODES = [
  ManualTriggerNode,
  WebhookTriggerNode,
  ScheduleTriggerNode,
  EventTriggerNode,
  FormTriggerNode,
  ChatTriggerNode,
] as const;

/**
 * All built-in flow-control node constructors (branching/routing/looping/
 * termination semantics).
 */
export const GRAPH_FLOW_CONTROL_NODES = [
  IfFlowNode,
  SwitchFlowNode,
  DelayFlowNode,
  ErrorBoundaryFlowNode,
  HumanApprovalFlowNode,
  LogFlowNode,
  BreakFlowNode,
] as const;

/**
 * All built-in utility node constructors (side-effect/data-transformation
 * semantics — no branching).
 */
export const GRAPH_UTILITY_NODES = [
  CodeNode,
  MapNode,
  UtilityLogNode,
] as const;

/**
 * All built-in loop node constructors (shared declarations of the
 * `core.loop.*` system kinds).
 */
export const GRAPH_LOOP_NODES = [
  GraphForeachLoopNode,
  GraphWhileLoopNode,
  GraphUntilLoopNode,
] as const;

/**
 * All built-in boundary node constructors.
 */
export const GRAPH_BOUNDARY_NODES = [
  GraphInputValueNode,
  GraphOutputValueNode,
] as const;

/**
 * All built-in mastra AI-family node constructors declared under the agent
 * category (SAA-836 M3): tools, hooks, skills, sandbox, and scorers, plus their
 * dynamic selectors.
 */
export const GRAPH_AGENT_FAMILY_NODES = [
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

/**
 * All built-in mastra memory node constructors declared under the agent
 * category (SAA-836 M2): the memory provider node wrapping mastra native
 * memory (conversation history, semantic recall, working memory) and its
 * dynamic selector.
 */
export const GRAPH_AGENT_MEMORY_NODES = [
  AgentMemoryNode,
  AgentMemorySelectorNode,
] as const;

/**
 * All built-in mastra RAG node constructors declared under the agent category
 * (SAA-836 M4): the embedding node, vector stores, retriever, chunking and
 * rerank nodes, the Q&A/basic/summarization chains, the structured-output
 * parser, the information extractor, and the LangChain Code glue kind.
 */
export const GRAPH_AGENT_RAG_NODES = [
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

/**
 * All built-in mastra processor node constructors declared under the agent
 * category (SAA-836 M5): the input (preprocessor) and output (post-processor)
 * processor nodes and the guardrail kind composing with the output-processor
 * pipeline.
 */
export const GRAPH_AGENT_PROCESSOR_NODES = [
  AgentInputProcessorNode,
  AgentOutputProcessorNode,
  AgentGuardrailNode,
] as const;

/**
 * All built-in mastra HITL and MCP-trigger node constructors declared under
 * the agent category (SAA-836 M5): the human-in-the-loop suspend/resume node
 * and the MCP Server Trigger exposing a workflow as an MCP server.
 */
export const GRAPH_AGENT_M5_NODES = [AgentHitlNode, McpServerTriggerNode] as const;

/**
 * All built-in M6 node constructors declared under the agent category
 * (SAA-836 M6): the Slack/Discord/Telegram/Teams channel triggers and their
 * matching response nodes, plus the mastra voice node.
 */
export const GRAPH_AGENT_M6_NODES = [
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
 * Kind→class map for every built-in node kind the backend executes
 * (DECAF-50 §4.26 R2-1). The catalogue derives each registration's
 * manifest and executor from the class, so this is the single authority for
 * built-in node behaviour.
 */
export const GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND: Record<string, GraphNodeClass> = {
  value: GraphInputValueNode,
  result: GraphOutputValueNode,
  "core.trigger.manual": ManualTriggerNode,
  "core.trigger.webhook": WebhookTriggerNode,
  "core.trigger.schedule": ScheduleTriggerNode,
  "core.trigger.event": EventTriggerNode,
  "core.trigger.form": FormTriggerNode,
  "core.trigger.chat": ChatTriggerNode,
  "core.flow.if": IfFlowNode,
  "core.flow.switch": SwitchFlowNode,
  "core.utility.map": MapNode,
  "core.flow.delay": DelayFlowNode,
  "core.flow.errorBoundary": ErrorBoundaryFlowNode,
  "core.flow.humanApproval": HumanApprovalFlowNode,
  "core.utility.code": CodeNode,
  "core.flow.log": LogFlowNode,
  "core.utility.log": UtilityLogNode,
  "core.flow.break": BreakFlowNode,
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
  "core.loop.foreach": GraphForeachLoopNode,
  "core.loop.while": GraphWhileLoopNode,
  "core.loop.until": GraphUntilLoopNode,
};
