/**
 * @module as-graph/nodes/agents/agent
 * @summary Production Agent node declaration.
 * @description The Agent node is the primary AI agent entrypoint. It is a
 * rectangular node with `@connection()` ports for its structural
 * dependencies: `model` (the LLM), `memory` (the memory store), and
 * `workspace` (the workspace/context). Connections are rendered on the
 * bottom side of the node (DECAF-32 §21.3). Each connection category has a
 * distinct color defined in the category style registry.
 *
 * The single `prompt` input accepts placeholder expressions (§22.4) such as
 * `{{ $input.brief }}` or `{{ $node["Research"].output.summary }}` that are
 * resolved at execution time by the placeholder compiler.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the agent node. */
export type AgentNodeInput = Record<string, unknown>;

/** Outputs produced by the agent node. */
export interface AgentNodeOutput {
  response: string;
  actions: unknown[];
}

/**
 * Agent node — an AI agent that orchestrates a model, memory, and workspace.
 *
 * The agent has:
 * - `@input` port on the **left**: `prompt` (the task prompt; supports
 *   placeholder expressions like `{{ $input.something }}` per §22.4).
 * - `@output` ports on the **right**: `response` (the agent's output), `actions`
 *   (any actions the agent decided to take).
 * - `@connection` ports on the **bottom**: `model` (LLM), `memory` (memory
 *   store), `workspace` (workspace/context). Each connection has a distinct
 *   category color.
 *
 * The node is rectangular (not rounded) to visually distinguish it from
 * regular processing nodes. The `color` and `icon` are omitted from `@node()`
 * so they are resolved from the `"Agent"` category style.
 */
@node("core.agent", {
  kind: "core.agent",
  category: "Agent",
  // color and icon omitted — resolved from the "Agent" category style
  width: 140,
  height: 120,
  labels: ["agent", "ai", "orchestrator"],
  metadata: {
    title: "graph.node.agent.agent.name",
    description:
      "graph.node.agent.agent.description",
    shape: "rectangle",
  },
})
@model()
export class AgentNode extends GraphNode<AgentNodeInput, AgentNodeOutput> {
  /**
   * Placeholder production implementation: echoes the (placeholder-resolved)
   * `prompt` input as the response and reports no actions.
   *
   * @param {GraphNodeExecutionRequest<AgentNodeInput>} request - Execution request carrying the resolved `prompt`.
   * @return {GraphExecutionValues} The `response`/`actions` output values.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentNodeInput>
  ): GraphExecutionValues {
    return {
      response: `[Agent response] ${String(request.inputs["prompt"] ?? "")}`,
      actions: [],
    };
  }

  // --- Inputs (left side) ---

  /** Task prompt; supports placeholder expressions like `{{ $input.brief }}` (§22.4). */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.agent.fields.prompt.label",
    placeholder: "graph.node.agent.agent.fields.prompt.placeholder",
    type: "textarea",
  })
  @input({ handle: "prompt" })
  prompt!: string;

  // --- Outputs (right side) ---

  /** Output carrying the agent's textual response. */
  @required()
  @output({ handle: "response" })
  response!: string;

  /** Output carrying any actions the agent decided to take. */
  @required()
  @output({ handle: "actions" })
  actions!: unknown[];

  // --- Connections (bottom side) ---

  /** Structural connection to the LLM backing this agent. */
  @connection({ category: "model", handle: "model" })
  model!: unknown;

  /** Structural connection to the agent's memory store. */
  @connection({ category: "memory", handle: "memory" })
  memory!: unknown;

  /** Structural connection to the agent's workspace/context. */
  @connection({ category: "workspace", handle: "workspace" })
  workspace!: unknown;
}

/**
 * All built-in agent node constructors.
 */
export const GRAPH_AGENT_NODES = [AgentNode] as const;
