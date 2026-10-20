/**
 * @module as-graph/mastra/nodes/types
 * @summary Contracts of the mastra node-kind registry (DECAF-809 Phase B).
 * @description Describes how every mastra-only node kind (`core.agent` and its
 * family) is bound to its built-in `GraphNode` class and to the factory that
 * produces its mastra step handlers, plus the shape of the coverage-gap records
 * the registry audit reports. The registry consumes these contracts so the
 * backend never hand-wires handlers per kind; see
 * {@link module:as-graph/mastra/nodes/MastraNodeRegistry}.
 */
import type { GraphNode } from "../../node/base";
import type { MastraNodeStepHandler } from "../types";
import type { MastraDefaultStepHandlerOptions } from "../MastraDefaultStepHandlers";
import type { MastraAgentStepHandlerOptions } from "../MastraAgentStepHandler";
import type { MastraMcpTriggerStepHandlerOptions } from "../MastraMcpTrigger";
import type { MastraChannelTriggerStepHandlerOptions } from "../MastraChannelTrigger";
import type { MastraChannelResponseStepHandlerOptions } from "../MastraChannelResponse";
import type { MastraVoiceStepHandlerOptions } from "../MastraVoiceStepHandler";
import type { MastraRagStepHandlerOptions } from "../MastraRagStepHandlers";

/** Minimal structural view of a built-in node class used by the registry. */
interface GraphNodeConstructor {
  readonly kind?: string;
  instantiate(config?: Record<string, unknown>): GraphNode;
}

/**
 * Options bundle forwarded to every step-handler factory the registry drives.
 * Each key maps to one handler group; omitted groups contribute no handlers.
 */
export interface MastraNodeHandlerOptions {
  default?: MastraDefaultStepHandlerOptions;
  agent?: MastraAgentStepHandlerOptions;
  mcp?: MastraMcpTriggerStepHandlerOptions;
  channelTrigger?: MastraChannelTriggerStepHandlerOptions;
  channelResponse?: MastraChannelResponseStepHandlerOptions;
  voice?: MastraVoiceStepHandlerOptions;
  rag?: MastraRagStepHandlerOptions;
}

/**
 * A complete mastra implementation of one node kind: the kind discriminator,
 * the built-in `GraphNode` class that owns its behaviour configuration, and
 * the factory producing the mastra step handlers for that kind only.
 */
export interface MastraNodeKindImplementation {
  kind: string;
  nodeClass: GraphNodeConstructor;
  createStepHandlers: (
    options: MastraNodeHandlerOptions
  ) => MastraNodeStepHandler[];
}

/**
 * A registered mastra-only node kind the registry cannot implement.
 * `missing-implementation` means no step handler group produces the kind;
 * `missing-node-class` means the kind has handlers but no built-in node class.
 */
export interface MastraNodeCoverageGap {
  kind: string;
  reason: "missing-implementation" | "missing-node-class";
}
