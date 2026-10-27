/**
 * @module as-graph/mastra/nodes/MastraNodeExecutionServices
 * @summary Typed, run-scoped execution services for Mastra-owned node kinds
 * (SAA-1545 §3.1).
 * @description Node classes are the single implementation of their declared
 * semantics. Capabilities that need host resources — the agent runtime, RAG
 * embedding/generation/vector stores, the sandbox runner, channel transports,
 * MCP servers, voice surfaces, and GraphExecutionContext-bound collaborators —
 * are injected per run through this contract. Services are attached to the
 * in-flight execution request only; they are never persisted in a
 * `GraphWorkflowDocument`, a node parameter, or serialized run state.
 *
 * A node that needs a service it was not given fails closed with a stable
 * {@link GraphExecutionError} before it can report success. The local engine
 * rejects these kinds through the engine-requirement gate
 * (`graphNodeRequiresMastraEngine`); on the Mastra engine the node's
 * `execute()` is the single implementation, and the step adapter attaches this
 * contract to the execution request.
 */
import type { GraphExecutionValues, GraphNodeExecutionRequest } from "../../engine/types";
import type { GraphNodeInstance } from "../../shared/graph/document/GraphNodeInstance";
import type { GraphWorkflowDocument } from "../../shared/graph/document/GraphWorkflowDocument";
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
import {
  GRAPH_MASTRA_AGENT_UNAVAILABLE,
  GRAPH_MASTRA_CHANNEL_UNAVAILABLE,
  GRAPH_MASTRA_HITL_UNAVAILABLE,
  GRAPH_MASTRA_MCP_UNAVAILABLE,
  GRAPH_MASTRA_RAG_UNAVAILABLE,
  GRAPH_MASTRA_VOICE_UNAVAILABLE,
} from "../types";

/** The run-scoped host runtime that executes a `core.agent` node. */
export interface MastraAgentNodeRuntime {
  execute(
    node: GraphNodeInstance,
    inputData: Record<string, unknown>,
    signal?: AbortSignal,
    document?: GraphWorkflowDocument
  ): Promise<GraphExecutionValues>;
}

/** The run-scoped host runtime that executes a RAG/sandbox family node. */
export interface MastraRagNodeRuntime {
  execute(
    kind: string,
    node: GraphNodeInstance,
    inputData: Record<string, unknown>,
    document?: GraphWorkflowDocument,
    signal?: AbortSignal
  ): Promise<GraphExecutionValues>;
}

/** The run-scoped host runtime that executes a channel trigger/response node. */
export interface MastraChannelNodeRuntime {
  trigger(
    node: GraphNodeInstance,
    inputData: Record<string, unknown>,
    document?: GraphWorkflowDocument,
    signal?: AbortSignal
  ): Promise<GraphExecutionValues>;
  response(
    node: GraphNodeInstance,
    inputData: Record<string, unknown>,
    document?: GraphWorkflowDocument,
    signal?: AbortSignal
  ): Promise<GraphExecutionValues>;
}

/** The run-scoped host runtime that executes a voice node. */
export interface MastraVoiceNodeRuntime {
  execute(
    node: GraphNodeInstance,
    inputData: Record<string, unknown>,
    document?: GraphWorkflowDocument,
    signal?: AbortSignal
  ): Promise<GraphExecutionValues>;
}

/** The run-scoped host runtime that executes an MCP trigger node. */
export interface MastraMcpNodeRuntime {
  execute(
    node: GraphNodeInstance,
    inputData: Record<string, unknown>,
    document?: GraphWorkflowDocument,
    signal?: AbortSignal
  ): Promise<GraphExecutionValues>;
}

/** The run-scoped host runtime that executes a HITL node. */
export interface MastraHitlNodeRuntime {
  execute(
    node: GraphNodeInstance,
    inputData: Record<string, unknown>,
    suspend?: (payload?: unknown) => unknown | Promise<unknown>,
    resumeData?: unknown
  ): Promise<GraphExecutionValues>;
}

/**
 * Typed execution-services contract injected into a Mastra node run. Every
 * member is optional because a node only requires the service its declared
 * capability needs; a missing required member fails the node closed.
 */
export interface MastraNodeExecutionServices {
  agent?: MastraAgentNodeRuntime;
  rag?: MastraRagNodeRuntime;
  channel?: MastraChannelNodeRuntime;
  voice?: MastraVoiceNodeRuntime;
  mcp?: MastraMcpNodeRuntime;
  hitl?: MastraHitlNodeRuntime;
  /** Optional host logger for log-like behaviour. */
  logger?: (message: string, meta?: Record<string, unknown>) => void;
  /** Host delay ceiling for delay-like behaviour. */
  maxDelayMs?: number;
}

/** Per-step runtime facts attached to a node execution request. */
export interface MastraNodeExecutionRuntime {
  node: GraphNodeInstance;
  document?: GraphWorkflowDocument;
  signal?: AbortSignal;
  services: MastraNodeExecutionServices;
  suspend?: (payload?: unknown) => unknown | Promise<unknown>;
  resumeData?: unknown;
}

/** A node execution request carrying its Mastra runtime services. */
export interface MastraNodeExecutionRequest<
  INPUT = Record<string, unknown>,
> extends GraphNodeExecutionRequest<INPUT> {
  readonly mastra: MastraNodeExecutionRuntime;
}

/**
 * Reads the Mastra runtime facts off a node request.
 *
 * @param request - The node execution request.
 * @returns The runtime facts, or `undefined` when the request did not come from
 *   the Mastra step adapter.
 */
export function mastraNodeRuntimeOf(
  request: GraphNodeExecutionRequest
): MastraNodeExecutionRuntime | undefined {
  return (request as MastraNodeExecutionRequest).mastra;
}

/**
 * Requires one host service, failing closed with a stable typed error when the
 * run did not inject it.
 *
 * @param request - The node execution request.
 * @param service - The service key the node requires.
 * @param code - The stable graph error code to throw when the service is absent.
 * @returns The injected service.
 * @throws {GraphExecutionError} when the request carries no runtime or the
 *   required service.
 */
export function requireMastraNodeService<
  K extends Exclude<keyof MastraNodeExecutionServices, "logger" | "maxDelayMs">,
>(
  request: GraphNodeExecutionRequest,
  service: K,
  code: string
): NonNullable<MastraNodeExecutionServices[K]> {
  const runtime = mastraNodeRuntimeOf(request);
  if (!runtime || !runtime.services[service]) {
    throw new GraphExecutionError(
      `Node '${request.nodeId}' of kind '${request.kind}' requires the '${service}' mastra execution service, which was not injected for this run`,
      code,
      { nodeId: request.nodeId, kind: request.kind, service }
    );
  }
  return runtime.services[service] as NonNullable<
    MastraNodeExecutionServices[K]
  >;
}

/** The stable fail-closed code for a missing family execution service. */
export function mastraServiceUnavailableCode(service: string): string {
  switch (service) {
    case "agent":
      return GRAPH_MASTRA_AGENT_UNAVAILABLE;
    case "rag":
      return GRAPH_MASTRA_RAG_UNAVAILABLE;
    case "channel":
      return GRAPH_MASTRA_CHANNEL_UNAVAILABLE;
    case "voice":
      return GRAPH_MASTRA_VOICE_UNAVAILABLE;
    case "mcp":
      return GRAPH_MASTRA_MCP_UNAVAILABLE;
    case "hitl":
      return GRAPH_MASTRA_HITL_UNAVAILABLE;
    default:
      return "GRAPH_MASTRA_EXECUTION_SERVICE_UNAVAILABLE";
  }
}
