/**
 * @module as-graph/mastra/nodes/hitl
 * @summary Mastra human-in-the-loop node declaration (SAA-836 M5).
 * @description HITL node with mastra suspend/resume semantics: the Mastra
 * engine translates this kind into a suspending step (`suspendSchema`/
 * `resumeSchema`) that suspends the workflow with the node's `message`/`prompt`
 * payload and resumes with the user's input through the mastra resume path
 * (the run service's owner-equality gate authorizes the resume write). The
 * local engine rejects `core.agent.hitl` through the engine-requirement gate;
 * on the Mastra engine the node's `execute()` is the single implementation,
 * invoked through the Mastra node step adapter. Square (rectangular) node
 * under the agent category (R4); it carries the `suspend` label.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../../node/base";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { GRAPH_MASTRA_HITL_UNAVAILABLE } from "../../types";
import { mastraNodeRuntimeOf } from "../MastraNodeExecutionServices";
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
   * Executes the human-in-the-loop semantics: on the first pass the node
   * suspends with its declared `message`/`prompt` payload through the injected
   * Mastra suspend surface; on resume it routes the validated payload to the
   * canonical `approved`/`rejected` outputs. Without a suspend surface the node
   * fails closed with `GRAPH_MASTRA_HITL_UNAVAILABLE` instead of fabricating a
   * user decision.
   *
   * @param {GraphNodeExecutionRequest<AgentHitlInput>} request - Execution request.
   * @return {Promise<GraphExecutionValues>} The approved/rejected output.
   * @throws {GraphExecutionError} when the run injected no suspend surface.
   */
  override async execute(
    request: GraphNodeExecutionRequest<AgentHitlInput>
  ): Promise<GraphExecutionValues> {
    const runtime = mastraNodeRuntimeOf(request);
    if (runtime?.resumeData === undefined) {
      if (!runtime?.suspend) {
        throw new GraphExecutionError(
          `Node '${request.nodeId}' of kind 'core.agent.hitl' requires a mastra suspend surface, which was not injected for this run`,
          GRAPH_MASTRA_HITL_UNAVAILABLE,
          { nodeId: request.nodeId, kind: request.kind, service: "hitl" }
        );
      }
      await runtime.suspend({ message: this.message, prompt: this.prompt });
    }
    const resumeData = runtime.resumeData as
      | { approved?: unknown; value?: unknown }
      | undefined;
    const value = resumeData?.value ?? resumeData;
    return resumeData?.approved === false
      ? { rejected: value }
      : { approved: value };
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
