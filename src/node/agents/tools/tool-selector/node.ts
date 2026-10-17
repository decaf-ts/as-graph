/**
 * @module as-graph/nodes/agents/tools/tool-selector
 * @summary Mastra Tool selector node declaration (SAA-836 M3).
 * @description Dynamic tools-selector node: selects one of several tools
 * supplied by the connected `tools` zone based on a decision input, then
 * resolves the selected tool resource on its output port. Connects only to the
 * agent `tools` zone.
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

/** Inputs accepted by the tool selector node. */
export type AgentToolSelectorInput = Record<string, unknown>;

/** Outputs produced by the tool selector node. */
export interface AgentToolSelectorOutput {
  resource: unknown;
  selected: unknown;
}

/**
 * Mastra Tool selector node: picks one connected tool from a decision input.
 */
@node("core.agent.toolSelector", {
  kind: "core.agent.toolSelector",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "tool", "selector"],
  metadata: {
    title: "graph.node.agent.tool_selector.name",
    description: "graph.node.agent.tool_selector.description",
    shape: "rectangle",
  },
})
@model()
export class AgentToolSelectorNode extends GraphNode<
  AgentToolSelectorInput,
  AgentToolSelectorOutput
> {
  /**
   * Selects a tool by decision and resolves it onto the `resource` output.
   *
   * @param {GraphNodeExecutionRequest<AgentToolSelectorInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource`/`selected` output values.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentToolSelectorInput>
  ): GraphExecutionValues {
    const decision = request.inputs["decision"] ?? request.inputs["value"];
    const available = this.tools ?? [];
    const selected =
      typeof decision === "string"
        ? decision
        : available.length
          ? available[0]
          : undefined;
    return {
      selected,
      resource: selected ? { type: "mastra.tool", toolId: selected } : null,
    };
  }

  /** Input carrying the tool-selection decision. */
  @input({ handle: "decision" })
  decision?: unknown;

  /** Declared tool ids the selector chooses between. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.tool_selector.fields.tools.label",
    type: "text",
  })
  @input({ handle: "tools", userControlled: true })
  tools?: string[];

  /** Output carrying the selected tool id. */
  @output({ handle: "selected" })
  selectedOut!: unknown;

  /** Output carrying the resolved mastra tool resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `tools` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.tools, handle: "tool" })
  tool!: unknown;
}

/** All built-in tool selector node constructors. */
export const GRAPH_AGENT_TOOL_SELECTOR_NODES = [AgentToolSelectorNode] as const;
