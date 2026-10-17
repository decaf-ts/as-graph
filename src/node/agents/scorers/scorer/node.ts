/**
 * @module as-graph/nodes/agents/scorers/scorer
 * @summary Mastra Scorer node declaration (SAA-836 M3).
 * @description Scorer node on the agent scorers zone, mirroring mastra's
 * `createScorer` config. Per R9 it resolves its configuration into the mastra
 * scorer resource on a real output port. Connects only to the agent `scorers`
 * zone, and multiple scorers may attach.
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

/** Inputs accepted by the scorer node. */
export type AgentScorerInput = Record<string, unknown>;

/** Outputs produced by the scorer node. */
export interface AgentScorerOutput {
  resource: unknown;
}

/**
 * Mastra Scorer node: supplies one configured scorer to the agent's `scorers`
 * zone.
 */
@node("core.agent.scorer", {
  kind: "core.agent.scorer",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "scorer", "eval"],
  metadata: {
    title: "graph.node.agent.scorer.name",
    description: "graph.node.agent.scorer.description",
    shape: "rectangle",
  },
})
@model()
export class AgentScorerNode extends GraphNode<
  AgentScorerInput,
  AgentScorerOutput
> {
  /**
   * Resolves the configured scorer into the mastra scorer resource descriptor.
   *
   * @param {GraphNodeExecutionRequest<AgentScorerInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource` output value.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentScorerInput>
  ): GraphExecutionValues {
    return {
      resource: {
        type: "mastra.scorer",
        id: this.scorerId,
        description: this.description,
        scorerType: this.scorerType,
        input: request.inputs,
      },
    };
  }

  /** The scorer id. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.scorer.fields.scorerId.label",
    type: "text",
  })
  @input({ handle: "scorerId", userControlled: true })
  scorerId!: string;

  /** The scorer description. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.scorer.fields.description.label",
    type: "textarea",
  })
  @input({ handle: "description", userControlled: true })
  description?: string;

  /** The mastra scorer type shortcut (e.g. `agent`, `traces`, `response`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.scorer.fields.scorerType.label",
    type: "select",
  })
  @input({ handle: "scorerType", userControlled: true })
  scorerType?: string;

  /** Output carrying the resolved mastra scorer resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `scorers` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.scorers, handle: "scorer" })
  scorer!: unknown;
}

/** All built-in scorer node constructors. */
export const GRAPH_AGENT_SCORER_NODES = [AgentScorerNode] as const;
