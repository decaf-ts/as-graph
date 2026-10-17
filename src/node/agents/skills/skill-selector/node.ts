/**
 * @module as-graph/nodes/agents/skills/skill-selector
 * @summary Mastra Skill selector node declaration (SAA-836 M3).
 * @description Dynamic skill selector: chooses one connected skill from a
 * decision input and resolves it on the output port. Connects only to the agent
 * `skill` zone.
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

/** Inputs accepted by the skill selector node. */
export type AgentSkillSelectorInput = Record<string, unknown>;

/** Outputs produced by the skill selector node. */
export interface AgentSkillSelectorOutput {
  resource: unknown;
  selected: unknown;
}

/**
 * Mastra Skill selector node: picks one connected skill from a decision input.
 */
@node("core.agent.skillSelector", {
  kind: "core.agent.skillSelector",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "skill", "selector"],
  metadata: {
    title: "graph.node.agent.skill_selector.name",
    description: "graph.node.agent.skill_selector.description",
    shape: "rectangle",
  },
})
@model()
export class AgentSkillSelectorNode extends GraphNode<
  AgentSkillSelectorInput,
  AgentSkillSelectorOutput
> {
  /**
   * Selects a skill by decision and resolves it onto the `resource` output.
   *
   * @param {GraphNodeExecutionRequest<AgentSkillSelectorInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource`/`selected` output values.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentSkillSelectorInput>
  ): GraphExecutionValues {
    const decision = request.inputs["decision"] ?? request.inputs["value"];
    const available = this.skills ?? [];
    const selected =
      typeof decision === "string"
        ? decision
        : available.length
          ? available[0]
          : undefined;
    return {
      selected,
      resource: selected ? { type: "mastra.skill", name: selected } : null,
    };
  }

  /** Input carrying the skill-selection decision. */
  @input({ handle: "decision" })
  decision?: unknown;

  /** Declared skill names the selector chooses between. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.skill_selector.fields.skills.label",
    type: "text",
  })
  @input({ handle: "skills", userControlled: true })
  skills?: string[];

  /** Output carrying the selected skill name. */
  @output({ handle: "selected" })
  selectedOut!: unknown;

  /** Output carrying the resolved mastra skill resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `skill` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.skill, handle: "skill" })
  skill!: unknown;
}

/** All built-in skill selector node constructors. */
export const GRAPH_AGENT_SKILL_SELECTOR_NODES = [AgentSkillSelectorNode] as const;
