/**
 * @module as-graph/nodes/agents/rag/chains/summarization
 * @summary Mastra Summarization chain node declaration (SAA-836 M4).
 * @description Summarization chain: condenses a set of documents into a summary,
 * compiled to a mastra workflow step through `MastraWorkflowCompiler`. The LLM is
 * carried as **config** (`modelAdapter`, R1) and the chain resolves into a
 * JSON-safe resource descriptor (R9); the live chain runs on the mastra backend.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../../shared/graph";
import { GraphNode } from "../../../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../../engine/types";

/** Inputs accepted by the summarization chain node. */
export type AgentSummarizationChainInput = Record<string, unknown>;

/** Outputs produced by the summarization chain node. */
export interface AgentSummarizationChainOutput {
  text: unknown;
  resource: unknown;
}

/**
 * Mastra Summarization chain node: summarizes documents/text with a configured
 * model.
 */
@node("core.agent.chain.summarization", {
  kind: "core.agent.chain.summarization",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "chain", "summarization"],
  metadata: {
    title: "graph.node.agent.chain.summarization.name",
    description: "graph.node.agent.chain.summarization.description",
    shape: "rectangle",
  },
})
@model()
export class AgentSummarizationChainNode extends GraphNode<
  AgentSummarizationChainInput,
  AgentSummarizationChainOutput
> {
  /**
   * Resolves the summarization chain config into a JSON-safe descriptor (R9).
   *
   * @param {GraphNodeExecutionRequest<AgentSummarizationChainInput>} request - Execution request.
   * @return {GraphExecutionValues} The `text`/`resource` outputs.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentSummarizationChainInput>
  ): GraphExecutionValues {
    const adapter = (this.modelAdapter ?? {}) as Record<string, unknown>;
    const documents = request.inputs["documents"];
    return {
      text: typeof request.inputs["text"] === "string" ? request.inputs["text"] : "",
      resource: {
        type: "mastra.chain.summarization",
        provider: adapter["provider"],
        modelId: adapter["modelId"],
        strategy: this.strategy ?? "stuff",
        documentCount: Array.isArray(documents) ? documents.length : 0,
      },
    };
  }

  /** Input carrying the documents to summarize. */
  @required()
  @input({ handle: "documents" })
  documents!: unknown;

  /**
   * The LLM backing the chain, carried as **config** (R1): `provider`,
   * `modelId`, and an optional credential reference.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chain.summarization.fields.modelAdapter.label",
    type: "object",
  })
  @input({ handle: "modelAdapter", userControlled: true, type: "object" })
  modelAdapter?: Record<string, unknown>;

  /** The summarization strategy (mastra chain type). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chain.summarization.fields.strategy.label",
    type: "select",
  })
  @input({ handle: "strategy", userControlled: true })
  strategy?: "stuff" | "map_reduce" | "refine";

  /** Optional instruction guiding the summary. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chain.summarization.fields.instructions.label",
    type: "textarea",
  })
  @input({ handle: "instructions", userControlled: true })
  instructions?: string;

  /** Output carrying the generated summary. */
  @required()
  @output({ handle: "text" })
  text!: unknown;

  /** Output carrying the resolved chain resource descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in summarization chain node constructors. */
export const GRAPH_AGENT_SUMMARIZATION_CHAIN_NODES = [
  AgentSummarizationChainNode,
] as const;
