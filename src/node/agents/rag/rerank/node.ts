/**
 * @module as-graph/nodes/agents/rag/rerank
 * @summary Mastra Rerank node declaration (SAA-836 M4).
 * @description RAG rerank node. It reorders retrieved documents with a reranker
 * model carried as **config** (`modelAdapter`, R1). Without a wired reranker the
 * node applies the config-only fallback (R9): it preserves the incoming order and
 * truncates to `topN`, returning the reranker resource descriptor alongside. The
 * live rerank runs on the mastra backend against the configured model.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the rerank node. */
export type AgentRerankInput = Record<string, unknown>;

/** Outputs produced by the rerank node. */
export interface AgentRerankOutput {
  documents: unknown;
  resource: unknown;
}

/**
 * Mastra Rerank node: reorders candidate documents by relevance to a query.
 */
@node("core.agent.rerank", {
  kind: "core.agent.rerank",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "rerank", "rag"],
  metadata: {
    title: "graph.node.agent.rerank.name",
    description: "graph.node.agent.rerank.description",
    shape: "rectangle",
  },
})
@model()
export class AgentRerankNode extends GraphNode<
  AgentRerankInput,
  AgentRerankOutput
> {
  /**
   * Applies the config-only rerank fallback (R9): preserves the incoming order,
   * truncates to `topN`, and returns the reranker resource descriptor.
   *
   * @param {GraphNodeExecutionRequest<AgentRerankInput>} request - Execution request.
   * @return {GraphExecutionValues} The `documents`/`resource` outputs.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentRerankInput>
  ): GraphExecutionValues {
    const documents = request.inputs["documents"];
    const list = Array.isArray(documents) ? documents : [];
    const topN = typeof this.topN === "number" && this.topN > 0 ? this.topN : undefined;
    const adapter = (this.modelAdapter ?? {}) as Record<string, unknown>;
    return {
      documents: topN !== undefined ? list.slice(0, topN) : list,
      resource: {
        type: "mastra.rerank",
        provider: adapter["provider"],
        modelId: adapter["modelId"],
        topN,
      },
    };
  }

  /** Input carrying the candidate documents to rerank. */
  @required()
  @input({ handle: "documents" })
  documents!: unknown;

  /** Input carrying the query the documents are ranked against. */
  @input({ handle: "query" })
  query?: unknown;

  /**
   * The reranker model, carried as **config** (R1): `provider`, `modelId`, and
   * an optional credential reference.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.rerank.fields.modelAdapter.label",
    type: "object",
  })
  @input({ handle: "modelAdapter", userControlled: true, type: "object" })
  modelAdapter?: Record<string, unknown>;

  /** The maximum number of documents to keep after reranking. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.rerank.fields.topN.label",
    type: "number",
  })
  @input({ handle: "topN", userControlled: true })
  topN?: number;

  /** Output carrying the reranked documents. */
  @required()
  @output({ handle: "documents" })
  documentsOut!: unknown;

  /** Output carrying the resolved reranker resource descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in rerank node constructors. */
export const GRAPH_AGENT_RERANK_NODES = [AgentRerankNode] as const;
