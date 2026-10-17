/**
 * @module as-graph/nodes/agents/processors/input-processor
 * @summary Mastra input-processor node declaration (SAA-836 M5).
 * @description Input-processor (preprocessor) node mirroring mastra's
 * `inputProcessors` agent pipeline. Per R9 it resolves its configuration into
 * the mastra input-processor resource on a real output port; the mastra backend
 * builds the real `@mastra/core/processors` instance from this resource and
 * applies it to agent execution as a per-run `inputProcessors` override.
 * Model-carrying processor types (`languageDetector`, `piiDetector`,
 * `promptInjectionDetector`, `systemPromptScrubber`) carry their classifier as **config** via
 * `modelAdapter` (R1 — no model-provider node kind). Connects only to the
 * agent `inputProcessors` zone.
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
import { MASTRA_INPUT_PROCESSOR_TYPES } from "../types";

/** Inputs accepted by the input-processor node. */
export type AgentInputProcessorInput = Record<string, unknown>;

/** Outputs produced by the input-processor node. */
export interface AgentInputProcessorOutput {
  resource: unknown;
}

/**
 * Mastra input-processor node: supplies one configured preprocessor to the
 * agent's `inputProcessors` zone (mastra's input-processing pipeline, R3).
 */
@node("core.agent.inputProcessor", {
  kind: "core.agent.inputProcessor",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "processor", "input"],
  metadata: {
    title: "graph.node.agent.input_processor.name",
    description: "graph.node.agent.input_processor.description",
    shape: "rectangle",
  },
})
@model()
export class AgentInputProcessorNode extends GraphNode<
  AgentInputProcessorInput,
  AgentInputProcessorOutput
> {
  /**
   * Resolves the configured preprocessor into the mastra input-processor
   * resource descriptor returned on the `resource` output port (R9 preferred
   * shape; the mastra backend builds the live processor from this descriptor).
   *
   * @param {GraphNodeExecutionRequest<AgentInputProcessorInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource` output value.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentInputProcessorInput>
  ): GraphExecutionValues {
    return {
      resource: {
        type: "mastra.inputProcessor",
        processorType: this.processorType,
        options: this.options,
        input: request.inputs,
      },
    };
  }

  /** The mastra-native input-processor type this node resolves to. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.input_processor.fields.processorType.label",
    type: "select",
  })
  @input({ handle: "processorType", userControlled: true })
  processorType!: (typeof MASTRA_INPUT_PROCESSOR_TYPES)[number];

  /** The processor options forwarded to the mastra processor constructor. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.input_processor.fields.options.label",
    type: "object",
  })
  @input({ handle: "options", userControlled: true, type: "object" })
  options?: Record<string, unknown>;

  /**
   * The classifier LLM for model-carrying processor types, carried as
   * **config** (R1): `provider`, `modelId`, and an optional credential
   * reference. Ignored by processor types that take no model.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.input_processor.fields.modelAdapter.label",
    type: "object",
  })
  @input({ handle: "modelAdapter", userControlled: true, type: "object" })
  modelAdapter?: Record<string, unknown>;

  /** Output carrying the resolved mastra input-processor resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `inputProcessors` zone. */
  @connection({
    category: MASTRA_AGENT_ZONE.inputProcessors,
    handle: "processors",
  })
  processors!: unknown;
}

/** All built-in input-processor node constructors. */
export const GRAPH_AGENT_INPUT_PROCESSOR_NODES = [
  AgentInputProcessorNode,
] as const;
