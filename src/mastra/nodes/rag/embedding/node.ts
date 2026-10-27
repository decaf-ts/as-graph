/**
 * @module as-graph/mastra/nodes/rag/embedding
 * @summary Mastra Embedding node declaration (SAA-836 M4).
 * @description Embedding node on the agent `embedding` zone. The embedding
 * model is carried as **config** (`modelAdapter`, R1 — there is no
 * model-provider node kind); the node's `execute()` delegates to the run-scoped
 * RAG runtime service, which produces the vectors and the mastra embedding
 * resource (or the config-only descriptor fallback). The Mastra step adapter
 * invokes that `execute()`. Connects only to the agent `embedding` zone.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../../node/base";
import {
  mastraNodeRuntimeOf,
  mastraServiceUnavailableCode,
  requireMastraNodeService,
} from "../../MastraNodeExecutionServices";
import { MASTRA_AGENT_ZONE } from "../../zones";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the embedding node. */
export type AgentEmbeddingInput = Record<string, unknown>;

/** Outputs produced by the embedding node. */
export interface AgentEmbeddingOutput {
  resource: unknown;
}

/**
 * Mastra Embedding node: supplies a configured embedding model to the agent's
 * `embedding` zone.
 */
@node("core.agent.embedding", {
  kind: "core.agent.embedding",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "embedding", "vector"],
  metadata: {
    title: "graph.node.agent.embedding.name",
    description: "graph.node.agent.embedding.description",
    shape: "rectangle",
  },
})
@model()
export class AgentEmbeddingNode extends GraphNode<
  AgentEmbeddingInput,
  AgentEmbeddingOutput
> {
  /**
   * Executes the declared node semantics through the run-scoped RAG execution
   * services (embedding, generation, vector store, and sandbox host ports). A
   * missing service fails closed with a stable typed graph execution error.
   *
   * @param {GraphNodeExecutionRequest<AgentEmbeddingInput>} request - Execution request.
   * @return {Promise<GraphExecutionValues>} The node outputs.
   */
  override async execute(
    request: GraphNodeExecutionRequest<AgentEmbeddingInput>
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

  /**
   * The embedding model, carried as **config** (R1): `provider`, `modelId`, an
   * optional credential reference, and optional model settings. Never a plain
   * secret — the credential reference is resolved by document validation stage 8.
   */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.embedding.fields.modelAdapter.label",
    type: "object",
  })
  @input({ handle: "modelAdapter", userControlled: true, type: "object" })
  modelAdapter?: Record<string, unknown>;

  /** The embedding dimension the model produces (used to size the vector index). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.embedding.fields.dimension.label",
    type: "number",
  })
  @input({ handle: "dimension", userControlled: true })
  dimension?: number;

  /** Optional maximum number of texts embedded per batch. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.embedding.fields.batchSize.label",
    type: "number",
  })
  @input({ handle: "batchSize", userControlled: true })
  batchSize?: number;

  /** Output carrying the resolved mastra embedding resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `embedding` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.embedding, handle: "embedding" })
  embedding!: unknown;
}

/** All built-in embedding node constructors. */
export const GRAPH_AGENT_EMBEDDING_NODES = [AgentEmbeddingNode] as const;
