/**
 * @module as-graph/nodes/agents/scorers/scorer-selector
 * @summary Mastra Scorer selector node declaration (SAA-836 M3).
 * @description Dynamic scorer selector: chooses one of several connected scorers
 * from a decision input and resolves it on the output port. Connects only to the
 * agent `scorers` zone.
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

/** Inputs accepted by the scorer selector node. */
export type AgentScorerSelectorInput = Record<string, unknown>;

/** Outputs produced by the scorer selector node. */
export interface AgentScorerSelectorOutput {
  resource: unknown;
  selected: unknown;
}

/**
 * Mastra Scorer selector node: picks one connected scorer from a decision input.
 */
@node("core.agent.scorerSelector", {
  kind: "core.agent.scorerSelector",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "scorer", "selector"],
  metadata: {
    title: "graph.node.agent.scorer_selector.name",
    description: "graph.node.agent.scorer_selector.description",
    shape: "rectangle",
  },
})
@model()
export class AgentScorerSelectorNode extends GraphNode<
  AgentScorerSelectorInput,
  AgentScorerSelectorOutput
> {
  /**
   * Selects a scorer by decision and resolves it onto the `resource` output.
   *
   * @param {GraphNodeExecutionRequest<AgentScorerSelectorInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource`/`selected` output values.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentScorerSelectorInput>
  ): GraphExecutionValues {
    const decision = request.inputs["decision"] ?? request.inputs["value"];
    const available = this.scorers ?? [];
    const selected =
      typeof decision === "string"
        ? decision
        : available.length
          ? available[0]
          : undefined;
    return {
      selected,
      resource: selected ? { type: "mastra.scorer", id: selected } : null,
    };
  }

  /** Input carrying the scorer-selection decision. */
  @input({ handle: "decision" })
  decision?: unknown;

  /** Declared scorer ids the selector chooses between. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.scorer_selector.fields.scorers.label",
    type: "text",
  })
  @input({ handle: "scorers", userControlled: true })
  scorers?: string[];

  /** Output carrying the selected scorer id. */
  @output({ handle: "selected" })
  selectedOut!: unknown;

  /** Output carrying the resolved mastra scorer resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `scorers` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.scorers, handle: "scorer" })
  scorer!: unknown;
}

/** All built-in scorer selector node constructors. */
export const GRAPH_AGENT_SCORER_SELECTOR_NODES = [
  AgentScorerSelectorNode,
] as const;
