/**
 * @module as-graph/nodes/agents/hooks/hook
 * @summary Mastra tool hook node declaration (SAA-836 M3).
 * @description Hook node on the agent hooks zone. It mirrors mastra's
 * `beforeToolCall`/`afterToolCall` hooks: the `phase` selects which hook it
 * represents and the node emits the hook context onto the sub-flow output ports
 * (`before`: `toolName`, `input`; `after`: `toolName`, `output`, `error`). The
 * sub-flow may terminate in a tool-deny node whose verdict flows back as the
 * hook result. Connects only to the agent `hooks` zone.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import { MASTRA_AGENT_ZONE } from "../../zones";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the hook node. */
export type AgentHookInput = Record<string, unknown>;

/** Outputs produced by the hook node (before and after context ports). */
export interface AgentHookOutput {
  toolName: unknown;
  input: unknown;
  output: unknown;
  error: unknown;
  value: unknown;
}

/**
 * Mastra hook node: represents a `beforeToolCall` or `afterToolCall` hook and
 * routes the hook context into a sub-flow.
 */
@node("core.agent.hook", {
  kind: "core.agent.hook",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "hook"],
  metadata: {
    title: "graph.node.agent.hook.name",
    description: "graph.node.agent.hook.description",
    shape: "rectangle",
  },
})
@model()
export class AgentHookNode extends GraphNode<AgentHookInput, AgentHookOutput> {
  /**
   * Routes the hook context (and the passthrough value) onto the sub-flow ports.
   *
   * @param {GraphNodeExecutionRequest<AgentHookInput>} request - Execution request.
   * @return {GraphExecutionValues} The hook context under its output ports.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentHookInput>
  ): GraphExecutionValues {
    const source = request.inputs ?? {};
    return {
      toolName: source["toolName"] ?? this.toolName,
      input: source["input"],
      output: source["output"],
      error: source["error"],
      value: source["value"] ?? source,
    };
  }

  /** Which mastra hook this node represents. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.hook.fields.phase.label",
    type: "select",
  })
  @input({ handle: "phase", userControlled: true })
  phase?: "before" | "after";

  /** The tool name the hook applies to (blank = all tools). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.hook.fields.toolName.label",
    type: "text",
  })
  @input({ handle: "toolName", userControlled: true })
  toolName?: string;

  /** Passthrough value carrying the hook context into the sub-flow. */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Hook context: the tool name. */
  @required()
  @output({ handle: "toolName" })
  toolNameOut!: unknown;

  /** Hook context (before): the model-supplied input. */
  @output({ handle: "input" })
  inputOut!: unknown;

  /** Hook context (after): the tool output. */
  @output({ handle: "output" })
  outputOut!: unknown;

  /** Hook context (after): the tool error. */
  @output({ handle: "error" })
  errorOut!: unknown;

  /** Passthrough value. */
  @output({ handle: "value" })
  valueOut!: unknown;

  /** Connection to the agent's `hooks` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.hooks, handle: "hook" })
  hook!: unknown;
}

/** All built-in hook node constructors. */
export const GRAPH_AGENT_HOOK_NODES = [AgentHookNode] as const;
