/**
 * @module as-graph/mastra/nodes/rag/chains/qa
 * @summary Mastra Question-and-Answer chain node declaration (SAA-836 M4).
 * @description RAG question-and-answer chain: it consumes a query plus retrieved
 * context and produces an answer. The LLM is carried as **config**
 * (`modelAdapter`, R1); the node's `execute()` delegates to the run-scoped RAG
 * runtime service, which generates the answer against the configured model (or
 * falls back to a JSON-safe descriptor when no model applies). The Mastra step
 * adapter invokes that `execute()`.
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

/** Inputs accepted by the Q&A chain node. */
export type AgentQaChainInput = Record<string, unknown>;

/** Outputs produced by the Q&A chain node. */
export interface AgentQaChainOutput {
  text: unknown;
  sourceDocuments: unknown;
  resource: unknown;
}

/**
 * Mastra Q&A chain node: answers a query from retrieved context.
 */
@node("core.agent.chain.qa", {
  kind: "core.agent.chain.qa",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "chain", "qa"],
  metadata: {
    title: "graph.node.agent.chain.qa.name",
    description: "graph.node.agent.chain.qa.description",
    shape: "rectangle",
  },
})
@model()
export class AgentQaChainNode extends GraphNode<
  AgentQaChainInput,
  AgentQaChainOutput
> {
  /**
   * Executes the declared node semantics through the run-scoped RAG execution
   * services (embedding, generation, vector store, and sandbox host ports). A
   * missing service fails closed with a stable typed graph execution error.
   *
   * @param {GraphNodeExecutionRequest<AgentQaChainInput>} request - Execution request.
   * @return {Promise<GraphExecutionValues>} The node outputs.
   */
  override async execute(
    request: GraphNodeExecutionRequest<AgentQaChainInput>
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

  /** Input carrying the natural-language question. */
  @required()
  @input({ handle: "query" })
  query!: unknown;

  /** Input carrying the retrieved context documents. */
  @input({ handle: "context" })
  context?: unknown;

  /**
   * The LLM backing the chain, carried as **config** (R1): `provider`,
   * `modelId`, and an optional credential reference.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chain.qa.fields.modelAdapter.label",
    type: "object",
  })
  @input({ handle: "modelAdapter", userControlled: true, type: "object" })
  modelAdapter?: Record<string, unknown>;

  /** Optional prompt template guiding the answer. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chain.qa.fields.promptTemplate.label",
    type: "textarea",
  })
  @input({ handle: "promptTemplate", userControlled: true })
  promptTemplate?: string;

  /** Whether the source documents are returned alongside the answer. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chain.qa.fields.returnSourceDocuments.label",
    type: "boolean",
  })
  @input({ handle: "returnSourceDocuments", userControlled: true })
  returnSourceDocuments?: boolean;

  /** Output carrying the generated answer. */
  @required()
  @output({ handle: "text" })
  text!: unknown;

  /** Output carrying the source documents when requested. */
  @output({ handle: "sourceDocuments" })
  sourceDocumentsOut!: unknown;

  /** Output carrying the resolved chain resource descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in Q&A chain node constructors. */
export const GRAPH_AGENT_QA_CHAIN_NODES = [AgentQaChainNode] as const;
