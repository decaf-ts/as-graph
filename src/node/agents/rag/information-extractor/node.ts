/**
 * @module as-graph/nodes/agents/rag/information-extractor
 * @summary Information Extractor node declaration (SAA-836 M4).
 * @description Extracts the structured information declared in the node's
 * `structuredOutput` schema from unstructured text. The extraction model is
 * carried as **config** (`modelAdapter`, R1) and the node resolves into a
 * JSON-safe resource descriptor (R9); the live extraction runs on the mastra
 * backend against the configured model.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the information extractor node. */
export type AgentInformationExtractorInput = Record<string, unknown>;

/** Outputs produced by the information extractor node. */
export interface AgentInformationExtractorOutput {
  data: unknown;
  resource: unknown;
}

/**
 * Information Extractor node: pulls declared structured fields out of text.
 */
@node("core.agent.informationExtractor", {
  kind: "core.agent.informationExtractor",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "extractor", "structured-output"],
  metadata: {
    title: "graph.node.agent.information_extractor.name",
    description: "graph.node.agent.information_extractor.description",
    shape: "rectangle",
  },
})
@model()
export class AgentInformationExtractorNode extends GraphNode<
  AgentInformationExtractorInput,
  AgentInformationExtractorOutput
> {
  /**
   * Resolves the extractor config into a JSON-safe descriptor; the extracted
   * data is produced by the mastra backend from the configured model.
   *
   * @param {GraphNodeExecutionRequest<AgentInformationExtractorInput>} request - Execution request.
   * @return {GraphExecutionValues} The `data`/`resource` outputs.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentInformationExtractorInput>
  ): GraphExecutionValues {
    const adapter = (this.modelAdapter ?? {}) as Record<string, unknown>;
    return {
      data: request.inputs["data"] ?? null,
      resource: {
        type: "mastra.informationExtractor",
        provider: adapter["provider"],
        modelId: adapter["modelId"],
        instructions: this.instructions,
        hasSchema: this.structuredOutput !== undefined,
      },
    };
  }

  /** Input carrying the unstructured text to extract from. */
  @required()
  @input({ handle: "text" })
  text!: unknown;

  /**
   * The extraction model, carried as **config** (R1): `provider`, `modelId`,
   * and an optional credential reference.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.information_extractor.fields.modelAdapter.label",
    type: "object",
  })
  @input({ handle: "modelAdapter", userControlled: true, type: "object" })
  modelAdapter?: Record<string, unknown>;

  /** The structured-output schema to extract (model-builder authored). */
  @uielement("ngx-decaf-model-builder", {
    label: "graph.node.agent.information_extractor.fields.structuredOutput.label",
  })
  @input({ handle: "structuredOutput", userControlled: true, type: "object" })
  structuredOutput?: unknown;

  /** Optional extraction instructions guiding the model. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.information_extractor.fields.instructions.label",
    type: "textarea",
  })
  @input({ handle: "instructions", userControlled: true })
  instructions?: string;

  /** Output carrying the extracted structured data. */
  @required()
  @output({ handle: "data" })
  data!: unknown;

  /** Output carrying the resolved extractor resource descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in information extractor node constructors. */
export const GRAPH_AGENT_INFORMATION_EXTRACTOR_NODES = [
  AgentInformationExtractorNode,
] as const;
