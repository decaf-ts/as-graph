/**
 * @module as-graph/nodes/agents/processors/output-processor
 * @summary Mastra output-processor node declaration (SAA-836 M5).
 * @description Output-processor (post-processor) node mirroring mastra's
 * `outputProcessors` agent pipeline. Per R9 it resolves its configuration into
 * the mastra output-processor resource on a real output port; the mastra
 * backend builds the real `@mastra/core/processors` instance from this
 * resource and applies it to agent execution as a per-run `outputProcessors`
 * override. Connects only to the agent `outputProcessors` zone, where
 * guardrail kinds compose alongside it.
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
import { MASTRA_OUTPUT_PROCESSOR_TYPES } from "../types";

/** Inputs accepted by the output-processor node. */
export type AgentOutputProcessorInput = Record<string, unknown>;

/** Outputs produced by the output-processor node. */
export interface AgentOutputProcessorOutput {
  resource: unknown;
}

/**
 * Mastra output-processor node: supplies one configured post-processor to the
 * agent's `outputProcessors` zone (mastra's output-processing pipeline, R3).
 */
@node("core.agent.outputProcessor", {
  kind: "core.agent.outputProcessor",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "processor", "output"],
  metadata: {
    title: "graph.node.agent.output_processor.name",
    description: "graph.node.agent.output_processor.description",
    shape: "rectangle",
  },
})
@model()
export class AgentOutputProcessorNode extends GraphNode<
  AgentOutputProcessorInput,
  AgentOutputProcessorOutput
> {
  /**
   * Resolves the configured post-processor into the mastra output-processor
   * resource descriptor returned on the `resource` output port (R9 preferred
   * shape; the mastra backend builds the live processor from this descriptor).
   *
   * @param {GraphNodeExecutionRequest<AgentOutputProcessorInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource` output value.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentOutputProcessorInput>
  ): GraphExecutionValues {
    return {
      resource: {
        type: "mastra.outputProcessor",
        processorType: this.processorType,
        options: this.options,
        input: request.inputs,
      },
    };
  }

  /** The mastra-native output-processor type this node resolves to. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.output_processor.fields.processorType.label",
    type: "select",
  })
  @input({ handle: "processorType", userControlled: true })
  processorType!: (typeof MASTRA_OUTPUT_PROCESSOR_TYPES)[number];

  /** The processor options forwarded to the mastra processor constructor. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.output_processor.fields.options.label",
    type: "object",
  })
  @input({ handle: "options", userControlled: true, type: "object" })
  options?: Record<string, unknown>;

  /** Output carrying the resolved mastra output-processor resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `outputProcessors` zone. */
  @connection({
    category: MASTRA_AGENT_ZONE.outputProcessors,
    handle: "processors",
  })
  processors!: unknown;
}

/** All built-in output-processor node constructors. */
export const GRAPH_AGENT_OUTPUT_PROCESSOR_NODES = [
  AgentOutputProcessorNode,
] as const;
