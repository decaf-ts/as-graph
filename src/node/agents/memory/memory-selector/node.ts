/**
 * @module as-graph/nodes/agents/memory/memory-selector
 * @summary Mastra Memory selector node declaration (SAA-836 M2).
 * @description Dynamic memory-selector node with the decision sub-flow shape:
 * it selects one of several declared memories (the `memories` config input, a
 * list of memory ids) based on a decision input, then resolves the selected
 * memory resource on its output port. Connects only to the agent `memory`
 * zone.
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

/** Inputs accepted by the memory selector node. */
export type AgentMemorySelectorInput = Record<string, unknown>;

/** Outputs produced by the memory selector node. */
export interface AgentMemorySelectorOutput {
  resource: unknown;
  selected: unknown;
}

/**
 * Mastra Memory selector node: picks one connected memory from a decision
 * input.
 */
@node("core.agent.memorySelector", {
  kind: "core.agent.memorySelector",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "memory", "selector"],
  metadata: {
    title: "graph.node.agent.memory_selector.name",
    description: "graph.node.agent.memory_selector.description",
    shape: "rectangle",
  },
})
@model()
export class AgentMemorySelectorNode extends GraphNode<
  AgentMemorySelectorInput,
  AgentMemorySelectorOutput
> {
  /**
   * Selects a memory by decision and resolves it onto the `resource` output.
   *
   * @param {GraphNodeExecutionRequest<AgentMemorySelectorInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource`/`selected` output values.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentMemorySelectorInput>
  ): GraphExecutionValues {
    const decision = request.inputs["decision"] ?? request.inputs["value"];
    const available = this.memories ?? [];
    const selected =
      typeof decision === "string"
        ? decision
        : available.length
          ? available[0]
          : undefined;
    return {
      selected,
      resource: selected ? { type: "mastra.memory", id: selected } : null,
    };
  }

  /** Input carrying the memory-selection decision. */
  @input({ handle: "decision" })
  decision?: unknown;

  /** Declared memory ids the selector chooses between. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.memory_selector.fields.memories.label",
    type: "text",
  })
  @input({ handle: "memories", userControlled: true })
  memories?: string[];

  /** Output carrying the selected memory id. */
  @output({ handle: "selected" })
  selectedOut!: unknown;

  /** Output carrying the resolved mastra memory resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `memory` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.memory, handle: "memory" })
  memory!: unknown;
}

/** All built-in memory selector node constructors. */
export const GRAPH_AGENT_MEMORY_SELECTOR_NODES = [AgentMemorySelectorNode] as const;
