/**
 * @module as-graph/mastra/nodes/hooks/delegation
 * @summary Mastra sub-agent delegation hook node declaration (SAA-836 M3).
 * @description Delegation hook node for sub-agents, mirroring mastra's
 * `onDelegationStart`/`onDelegationComplete` hooks. It connects to a
 * sub-agent's (`core.agent.subAgent`) `hooks` zone, so it applies to the
 * delegations the supervisor makes to that sub-agent; the `phase` selects
 * which hook it is. On `start` it can rewrite the prompt (`prompt`, with a
 * `{{prompt}}` placeholder for the original), the sub-agent instructions and
 * its step budget; a sub-flow ending in `core.agent.toolDeny` rejects the
 * delegation with the deny node's `reason`. On `complete` it can add
 * `feedback` to the supervisor's conversation; a sub-flow ending in a deny
 * node replaces the result the supervisor's model sees with the deny node's
 * `replacement` (or `reason`). The node also emits the delegation context onto
 * its sub-flow output ports.
 */
import { min, model, required, option } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../../node/base";
import { MASTRA_AGENT_ZONE } from "../../zones";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the delegation hook node. */
export type AgentDelegationHookInput = Record<string, unknown>;

/** Outputs produced by the delegation hook node. */
export interface AgentDelegationHookOutput {
  fromAgentId: unknown;
  toAgentId: unknown;
  input: unknown;
  output: unknown;
  error: unknown;
  value: unknown;
}

/**
 * Mastra delegation hook node: represents an `onDelegationStart` or
 * `onDelegationComplete` hook for a sub-agent delegation.
 */
@node("core.agent.delegationHook", {
  kind: "core.agent.delegationHook",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "hook", "delegation"],
  metadata: {
    title: "graph.node.agent.delegation_hook.name",
    description: "graph.node.agent.delegation_hook.description",
    shape: "rectangle",
  },
})
@model()
export class AgentDelegationHookNode extends GraphNode<
  AgentDelegationHookInput,
  AgentDelegationHookOutput
> {
  /**
   * Routes the delegation context onto the sub-flow output ports.
   *
   * @param {GraphNodeExecutionRequest<AgentDelegationHookInput>} request - Execution request.
   * @return {GraphExecutionValues} The delegation context under its output ports.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentDelegationHookInput>
  ): GraphExecutionValues {
    const source = request.inputs ?? {};
    return {
      fromAgentId: source["fromAgentId"],
      toAgentId: source["toAgentId"],
      input: source["input"],
      output: source["output"],
      error: source["error"],
      value: source["value"] ?? source,
    };
  }

  /** Which mastra delegation hook this node represents. */
  @option(["start", "complete"])
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.delegation_hook.fields.phase.label",
    type: "select",
  })
  @input({ handle: "phase", userControlled: true })
  phase?: "start" | "complete";

  /**
   * `start` phase: the prompt sent to the sub-agent instead of the
   * supervisor's; `{{prompt}}` is replaced with the original prompt.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.delegation_hook.fields.prompt.label",
    type: "textarea",
  })
  @input({ handle: "prompt", userControlled: true })
  prompt?: string;

  /** `start` phase: instructions that replace the sub-agent's for this call. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.delegation_hook.fields.instructions.label",
    type: "textarea",
  })
  @input({ handle: "instructions", userControlled: true })
  instructions?: string;

  /** `start` phase: the sub-agent's step budget for this call. */
  @min(1)
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.delegation_hook.fields.maxSteps.label",
    type: "number",
  })
  @input({ handle: "maxSteps", userControlled: true })
  maxSteps?: number;

  /** `complete` phase: feedback added to the supervisor's conversation. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.delegation_hook.fields.feedback.label",
    type: "textarea",
  })
  @input({ handle: "feedback", userControlled: true })
  feedback?: string;

  /** Passthrough value carrying the delegation context into the sub-flow. */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** The delegating (parent) agent id. */
  @output({ handle: "fromAgentId" })
  fromAgentIdOut!: unknown;

  /** The target (sub) agent id. */
  @output({ handle: "toAgentId" })
  toAgentIdOut!: unknown;

  /** The input forwarded to the sub-agent (start phase). */
  @output({ handle: "input" })
  inputOut!: unknown;

  /** The sub-agent output (complete phase). */
  @output({ handle: "output" })
  outputOut!: unknown;

  /** The delegation error (complete phase). */
  @output({ handle: "error" })
  errorOut!: unknown;

  /** Passthrough value. */
  @output({ handle: "value" })
  valueOut!: unknown;

  /** Connection to a sub-agent's `hooks` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.hooks, handle: "hook" })
  hook!: unknown;
}

/** All built-in delegation hook node constructors. */
export const GRAPH_AGENT_DELEGATION_HOOK_NODES = [AgentDelegationHookNode] as const;
