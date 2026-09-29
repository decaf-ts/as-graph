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
import { connection, input, node, output } from "../../shared/graph";
import { GraphNode } from "../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";

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
    title: "Agent",
    description:
      "AI agent that orchestrates a model, memory, and workspace to complete a task.",
    shape: "rectangle",
  },
})
@model()
export class AgentNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return {
      response: `[Agent response] ${String(request.inputs["prompt"] ?? "")}`,
      actions: [],
    };
  }

  // --- Inputs (left side) ---

  @required()
  @uielement("textarea", {
    label: "Prompt",
    placeholder:
      'Enter task prompt. Supports placeholders like {{ $input.brief }} or {{ $node["Research"].output.summary }}',
  })
  @input({ handle: "prompt" })
  prompt!: string;

  // --- Outputs (right side) ---

  @required()
  @uielement("textarea", { label: "Response", placeholder: "Agent response" })
  @output({ handle: "response" })
  response!: string;

  @required()
  @uielement("textarea", {
    label: "Actions",
    placeholder: "Actions taken by the agent",
  })
  @output({ handle: "actions" })
  actions!: unknown[];

  // --- Connections (bottom side) ---

  @connection({ category: "model", handle: "model" })
  model!: unknown;

  @connection({ category: "memory", handle: "memory" })
  memory!: unknown;

  @connection({ category: "workspace", handle: "workspace" })
  workspace!: unknown;
}

/**
 * All built-in agent node constructors.
 */
export const GRAPH_AGENT_NODES = [AgentNode] as const;
