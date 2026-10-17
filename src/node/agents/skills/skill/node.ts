/**
 * @module as-graph/nodes/agents/skills/skill
 * @summary Mastra Skill node declaration (SAA-836 M3).
 * @description Skill node on the agent skill zone, mirroring mastra's
 * `createSkill`/`AgentSkillsInput` config. Per R9 it resolves its configuration
 * into the mastra skill resource on a real output port. Connects only to the
 * agent `skill` zone.
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

/** Inputs accepted by the skill node. */
export type AgentSkillInput = Record<string, unknown>;

/** Outputs produced by the skill node. */
export interface AgentSkillOutput {
  resource: unknown;
}

/**
 * Mastra Skill node: supplies one configured skill to the agent's `skill` zone.
 */
@node("core.agent.skill", {
  kind: "core.agent.skill",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "skill"],
  metadata: {
    title: "graph.node.agent.skill.name",
    description: "graph.node.agent.skill.description",
    shape: "rectangle",
  },
})
@model()
export class AgentSkillNode extends GraphNode<AgentSkillInput, AgentSkillOutput> {
  /**
   * Resolves the configured skill into the mastra skill resource descriptor.
   *
   * @param {GraphNodeExecutionRequest<AgentSkillInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource` output value.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentSkillInput>
  ): GraphExecutionValues {
    return {
      resource: {
        type: "mastra.skill",
        name: this.name,
        description: this.description,
        input: request.inputs,
      },
    };
  }

  /** The skill name. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.skill.fields.name.label",
    type: "text",
  })
  @input({ handle: "name", userControlled: true })
  name!: string;

  /** The skill description. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.skill.fields.description.label",
    type: "textarea",
  })
  @input({ handle: "description", userControlled: true })
  description?: string;

  /** The skill instructions/body. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.skill.fields.instructions.label",
    type: "textarea",
  })
  @input({ handle: "instructions", userControlled: true })
  instructions?: string;

  /** Output carrying the resolved mastra skill resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `skill` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.skill, handle: "skill" })
  skill!: unknown;
}

/** All built-in skill node constructors. */
export const GRAPH_AGENT_SKILL_NODES = [AgentSkillNode] as const;
