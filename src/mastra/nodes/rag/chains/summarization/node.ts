/**
 * @module as-graph/mastra/nodes/rag/chains/summarization
 * @summary Mastra Summarization chain node declaration (SAA-836 M4).
 * @description Summarization chain: condenses a set of documents into a summary.
 * The LLM is carried as **config** (`modelAdapter`, R1); the node's `execute()`
 * delegates to the run-scoped RAG runtime service, which generates the summary
 * (falling back to a JSON-safe descriptor when no model applies). The Mastra
 * step adapter invokes that `execute()`.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../../shared/graph";
import { GraphNode } from "../../../../../node/base";
import {
  mastraNodeRuntimeOf,
  mastraServiceUnavailableCode,
  requireMastraNodeService,
} from "../../../MastraNodeExecutionServices";
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
   * Executes the declared node semantics through the run-scoped RAG execution
   * services (the model/generation host port). A missing service fails closed
   * with a stable typed graph execution error.
   *
   * @param {GraphNodeExecutionRequest<AgentSummarizationChainInput>} request - Execution request.
   * @return {Promise<GraphExecutionValues>} The node outputs.
   */
  override async execute(
    request: GraphNodeExecutionRequest<AgentSummarizationChainInput>
  ): Promise<GraphExecutionValues> {
    const runtime = requireMastraNodeService(
      request,
      "rag",
      mastraServiceUnavailableCode("rag")
    );
    const mastra = mastraNodeRuntimeOf(request)!;
    return runtime.execute(
      request.kind,
      mastra.node,
      request.inputs,
      mastra.document,
      mastra.signal
    );
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
