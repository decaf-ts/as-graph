/**
 * @module as-graph/nodes/agents/hitl
 * @summary Mastra human-in-the-loop node declaration (SAA-836 M5).
 * @description HITL node with mastra suspend/resume semantics: the mastra
 * backend translates this kind into a suspending step (`suspendSchema`/
 * `resumeSchema`) that suspends the workflow with the node's `message`/`prompt`
 * payload and resumes with the user's input through the mastra resume path
 * (the run service's owner-equality gate authorizes the resume write). The
 * node never executes on the general engine; `core.agent.hitl` requires the
 * mastra engine and fails closed otherwise. Square (rectangular) node under
 * the agent category (R4); it carries the `suspend` label.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { GRAPH_LOCAL_UNSUPPORTED_NODE_KIND } from "../../../engine/constants";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the HITL node. */
export type AgentHitlInput = Record<string, unknown>;

/** Outputs produced by the HITL node. */
export interface AgentHitlOutput {
  approved: unknown;
  rejected: unknown;
}

/**
 * Mastra human-in-the-loop node: suspends the workflow until a user supplies
 * the requested input, then resumes through the mastra resume path.
 */
@node("core.agent.hitl", {
  kind: "core.agent.hitl",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "hitl", "suspend"],
  metadata: {
    title: "graph.node.agent.hitl.name",
    description: "graph.node.agent.hitl.description",
    shape: "rectangle",
  },
})
@model()
export class AgentHitlNode extends GraphNode<AgentHitlInput, AgentHitlOutput> {
  /**
   * The general engine cannot run the HITL kind: `core.agent.hitl` executes
   * only on the mastra backend (which translates it into a suspending step
   * with mastra suspend/resume semantics). Fails closed with
   * {@link GRAPH_LOCAL_UNSUPPORTED_NODE_KIND} so the general engine never
   * fabricates a user decision.
   *
   * @param {GraphNodeExecutionRequest<AgentHitlInput>} _request - Unused; the HITL kind is mastra-only.
   * @return {GraphExecutionValues} Never returns.
   */
  override execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphNodeExecutionRequest<AgentHitlInput>
  ): GraphExecutionValues {
    throw new GraphExecutionError(
      `Node kind 'core.agent.hitl' requires the mastra engine, which the local backend does not provide`,
      GRAPH_LOCAL_UNSUPPORTED_NODE_KIND,
      { kind: "core.agent.hitl", backend: "local" }
    );
  }

  /** Value routed to the approved/rejected output once the user responds. */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Human-facing message shown while execution is suspended for input. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.hitl.fields.message.label",
    placeholder: "graph.node.agent.hitl.fields.message.placeholder",
    type: "textarea",
  })
  @input({ handle: "message", userControlled: true })
  message?: string;

  /** The question the suspended step asks the user (mastra suspend payload). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.hitl.fields.prompt.label",
    type: "textarea",
  })
  @input({ handle: "prompt", userControlled: true })
  prompt?: string;

  /**
   * Shape of the user's resume input, declared via the model-builder UI.
   * The suspended mastra step validates every resume payload against this
   * schema (C15); the run service's owner-equality gate authorizes who may
   * supply it.
   */
  @required()
  @input({ handle: "resumeSchema" })
  @uielement("ngx-decaf-model-builder", {
    label: "graph.node.agent.hitl.fields.resumeSchema.label",
    placeholder: "graph.node.agent.hitl.fields.resumeSchema.placeholder",
  })
  resumeSchema?: unknown;

  /** Output carrying the user's value when the resume approves. */
  @output({ handle: "approved" })
  approvedOut!: unknown;

  /** Output carrying the user's value when the resume explicitly declines. */
  @output({ handle: "rejected" })
  rejectedOut!: unknown;
}

/** All built-in HITL node constructors. */
export const GRAPH_AGENT_HITL_NODES = [AgentHitlNode] as const;
