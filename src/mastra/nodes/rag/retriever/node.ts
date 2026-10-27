/**
 * @module as-graph/mastra/nodes/rag/retriever
 * @summary Mastra Retriever node declaration (SAA-836 M4).
 * @description RAG retriever node. It takes a vector-store resource (from a
 * `core.agent.vectorStore` node) plus a query; the node's `execute()` delegates
 * to the run-scoped RAG runtime service, which queries the store and resolves
 * the retrieved documents onto the `documents` output port, also exposing the
 * resolution as a JSON-safe resource descriptor (R9). The Mastra step adapter
 * invokes that `execute()`.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../../node/base";
import {
  mastraNodeRuntimeOf,
  mastraServiceUnavailableCode,
  requireMastraNodeService,
} from "../../MastraNodeExecutionServices";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the retriever node. */
export type AgentRetrieverInput = Record<string, unknown>;

/** Outputs produced by the retriever node. */
export interface AgentRetrieverOutput {
  documents: unknown;
  resource: unknown;
}

/**
 * Mastra Retriever node: performs a similarity retrieval against a configured
 * vector store.
 */
@node("core.agent.retriever", {
  kind: "core.agent.retriever",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "retriever", "rag"],
  metadata: {
    title: "graph.node.agent.retriever.name",
    description: "graph.node.agent.retriever.description",
    shape: "rectangle",
  },
})
@model()
export class AgentRetrieverNode extends GraphNode<
  AgentRetrieverInput,
  AgentRetrieverOutput
> {
  /**
   * Executes the declared node semantics through the run-scoped RAG execution
   * services (embedding, generation, vector store, and sandbox host ports). A
   * missing service fails closed with a stable typed graph execution error.
   *
   * @param {GraphNodeExecutionRequest<AgentRetrieverInput>} request - Execution request.
   * @return {Promise<GraphExecutionValues>} The node outputs.
   */
  override async execute(
    request: GraphNodeExecutionRequest<AgentRetrieverInput>
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

  /** Input carrying the vector-store resource resolved by a vector-store node (R9). */
  @required()
  @input({ handle: "store" })
  store!: unknown;

  /** Input carrying the natural-language query. */
  @required()
  @input({ handle: "query" })
  query!: unknown;

  /** Optional query vector, when the caller supplies the embedding directly. */
  @input({ handle: "queryVector" })
  queryVector?: unknown;

  /** Optional metadata filter applied to the query. */
  @input({ handle: "filter", type: "object" })
  filter?: Record<string, unknown>;

  /** Maximum number of documents to retrieve. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.retriever.fields.topK.label",
    type: "number",
  })
  @input({ handle: "topK", userControlled: true })
  topK?: number;

  /** The index name to retrieve from. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.retriever.fields.indexName.label",
    type: "text",
  })
  @input({ handle: "indexName", userControlled: true })
  indexName?: string;

  /** Output carrying the retrieved documents. */
  @required()
  @output({ handle: "documents" })
  documents!: unknown;

  /** Output carrying the resolved retriever resource descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in retriever node constructors. */
export const GRAPH_AGENT_RETRIEVER_NODES = [AgentRetrieverNode] as const;
