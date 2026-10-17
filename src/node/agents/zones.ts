/**
 * @module as-graph/nodes/agents/zones
 * @summary Canonical mastra agent connection-port zone categories (SAA-836 M3).
 * @description The agent node exposes one dedicated connection zone per mastra
 * AI family. A family node's `@connection()` port carries the same category, so
 * a connection edge is only valid between a family port and its matching agent
 * zone (the connection-category rule in the edge validator rejects a cross-family
 * edge). Kept in one module so the agent node (M1), every family node (M3),
 * and the M5 processor/guardrail/HITL kinds share a single authority for the
 * category strings. The `inputProcessors`/`outputProcessors` zones (SAA-836 M5)
 * carry mastra's input (preprocessor) and output (post-processor) pipelines;
 * guardrail kinds connect on the `outputProcessors` zone, composing with the
 * output-processor pipeline.
 */

/** A mastra agent connection-port zone category. */
export const MASTRA_AGENT_ZONE = {
  memory: "memory",
  scorers: "scorers",
  embedding: "embedding",
  hooks: "hooks",
  sandbox: "sandbox",
  tools: "tools",
  skill: "skill",
  inputProcessors: "inputProcessors",
  outputProcessors: "outputProcessors",
} as const;

/** Union of the canonical mastra agent zone categories. */
export type MastraAgentZone =
  (typeof MASTRA_AGENT_ZONE)[keyof typeof MASTRA_AGENT_ZONE];

/** Every canonical mastra agent zone category, in palette order. */
export const MASTRA_AGENT_ZONES: readonly MastraAgentZone[] = [
  MASTRA_AGENT_ZONE.memory,
  MASTRA_AGENT_ZONE.scorers,
  MASTRA_AGENT_ZONE.embedding,
  MASTRA_AGENT_ZONE.hooks,
  MASTRA_AGENT_ZONE.sandbox,
  MASTRA_AGENT_ZONE.tools,
  MASTRA_AGENT_ZONE.skill,
  MASTRA_AGENT_ZONE.inputProcessors,
  MASTRA_AGENT_ZONE.outputProcessors,
];
