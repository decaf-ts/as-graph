/**
 * @module as-graph/mastra/nodes/agent/sub-agent
 * @summary Mastra sub-agent node declaration.
 * @description A sub-agent is an agent another agent delegates to. It is an
 * {@link AgentNode} — same model adapter, instructions, options and zones
 * (memory, tools, skill, hooks, sandbox, scorers, processors and its own
 * `subagents`) — that is not invoked by a data edge: it connects through its
 * `parent` port to a supervisor's `subagents` zone, and the supervisor's model
 * calls it as the `agent-<name>` tool (mastra's `agents` option). It therefore
 * drops the agent's `prompt`/`response`/`actions`/`object` data ports
 * (`@node({ omitPorts })`) and emits its JSON-safe descriptor on `resource`,
 * like the other zone nodes. Delegation hooks (`core.agent.delegationHook`)
 * attach to the sub-agent's own `hooks` zone, so the delegations they observe
 * are the ones made to this sub-agent.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { connection, node, output } from "../../../../shared/graph";
import { AgentNode } from "../node";
import { MASTRA_AGENT_ZONE } from "../../zones";
import {
  graphModelAdapterOf,
  mastraModelConfigOf,
} from "../../../MastraAgentModelAdapter";
import { mastraNodeRuntimeOf } from "../../MastraNodeExecutionServices";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";
import type { GraphNodeInstance } from "../../../../shared/graph/document/GraphNodeInstance";

/** The JSON-safe descriptor a sub-agent node emits on `resource`. */
export interface MastraSubAgentDescriptor {
  type: "mastra.subAgent";
  /** The sub-agent's agent id (its node id; mastra's delegation `primitiveId`). */
  id: string;
  /** The key the supervisor registers it under (`agent-<key>` tool). */
  key: string;
  name: string;
  description?: string;
  /** `<provider>/<modelId>`, when the node declares a model adapter. */
  model?: string;
}

/**
 * The key a sub-agent is registered under on its supervisor. Mastra exposes it
 * to the model as the `agent-<key>` tool, so it is reduced to the characters
 * tool names allow.
 *
 * @param node - The sub-agent node instance.
 * @returns The registration key.
 */
export function mastraSubAgentKeyOf(node: GraphNodeInstance): string {
  const name = node.parameters?.["name"];
  const base = typeof name === "string" && name.trim() ? name : node.id;
  const key = base
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || node.id.replace(/[^A-Za-z0-9_-]+/g, "_");
}

/**
 * Builds the descriptor of a sub-agent node.
 *
 * @param node - The sub-agent node instance.
 * @returns The descriptor.
 */
export function mastraSubAgentDescriptorOf(
  node: GraphNodeInstance
): MastraSubAgentDescriptor {
  const parameters = (node.parameters ?? {}) as Record<string, unknown>;
  const adapter = graphModelAdapterOf(node);
  const name =
    typeof parameters["name"] === "string" && parameters["name"].trim()
      ? (parameters["name"] as string)
      : node.label ?? node.id;
  return {
    type: "mastra.subAgent",
    id: node.id,
    key: mastraSubAgentKeyOf(node),
    name,
    ...(typeof parameters["description"] === "string" &&
    parameters["description"].trim()
      ? { description: parameters["description"] as string }
      : {}),
    ...(adapter ? { model: mastraModelConfigOf(adapter).id } : {}),
  };
}

/**
 * Mastra sub-agent node: an agent a supervisor agent delegates to.
 */
@node("core.agent.subAgent", {
  kind: "core.agent.subAgent",
  category: "Agent",
  width: 168,
  height: 132,
  labels: ["agent", "ai", "sub-agent", "delegation"],
  omitPorts: ["prompt", "response", "actions", "object"],
  metadata: {
    title: "graph.node.agent.sub_agent.name",
    description: "graph.node.agent.sub_agent.description",
    shape: "rectangle",
  },
})
@model()
export class SubAgentNode extends AgentNode {
  /**
   * Emits the sub-agent's descriptor. The sub-agent runs inside its
   * supervisor's model loop, when the supervisor's model delegates to it; the
   * supervisor's agent factory builds it from this node's fields and zones.
   *
   * @param {GraphNodeExecutionRequest} request - Execution request.
   * @return {GraphExecutionValues} The `resource` descriptor.
   */
  override async execute(
    request: GraphNodeExecutionRequest<never>
  ): Promise<GraphExecutionValues> {
    const instance =
      (mastraNodeRuntimeOf(request)?.node as GraphNodeInstance | undefined) ??
      ({
        id: request.nodeId,
        kind: request.kind,
        parameters: (request as { parameters?: Record<string, unknown> })
          .parameters,
      } as GraphNodeInstance);
    return { resource: mastraSubAgentDescriptorOf(instance) };
  }

  /** The sub-agent's descriptor (`MastraSubAgentDescriptor`). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the supervisor agent's `subagents` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.subagents, handle: "parent" })
  parent!: unknown;
}

/** All built-in sub-agent node constructors. */
export const GRAPH_SUB_AGENT_NODES = [SubAgentNode] as const;
