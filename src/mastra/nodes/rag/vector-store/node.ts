/**
 * @module as-graph/mastra/nodes/rag/vector-store
 * @summary Mastra Vector Store node declaration (SAA-836 M4).
 * @description RAG vector-store backing node. It holds the **config** that
 * selects and describes a mastra vector store (provider, index, dimension,
 * metric, credential reference); the node's `execute()` delegates to the
 * run-scoped RAG runtime service, which resolves the store, inserts or queries
 * it, and emits the mastra store resource on a real output port (per R9; the
 * config-only descriptor fallback remains valid). The Mastra step adapter
 * invokes that `execute()`. Providers are `memory` (built-in in-memory
 * baseline), the mastra-native bindings (`pgvector`, `redis`, `upstash`,
 * `qdrant`, `pinecone`, `supabase`, `mongodb`, `libsql`, `chroma`), and
 * `age`/`graph` (custom `MastraVector` stores over a host driver), so the
 * remainder of mastra's supported stores uses the same config pattern.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { assertNoMastraPlainConnectionCredentials } from "../../../MastraEnvironment";
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

/** Inputs accepted by the vector-store node. */
export type AgentVectorStoreInput = Record<string, unknown>;

/** Outputs produced by the vector-store node. */
export interface AgentVectorStoreOutput {
  resource: unknown;
  inserted: unknown;
  documents: unknown;
}

/**
 * Mastra Vector Store node: supplies a configured RAG vector store (memory,
 * pgvector, redis, age, or graph) to a retriever through its `resource` port.
 */
@node("core.agent.vectorStore", {
  kind: "core.agent.vectorStore",
  category: "Agent",
  width: 140,
  height: 120,
  labels: ["agent", "ai", "vector-store", "rag"],
  metadata: {
    title: "graph.node.agent.vector_store.name",
    description: "graph.node.agent.vector_store.description",
    shape: "rectangle",
  },
})
@model()
export class AgentVectorStoreNode extends GraphNode<
  AgentVectorStoreInput,
  AgentVectorStoreOutput
> {
  /**
   * Executes the declared node semantics through the run-scoped RAG execution
   * services (embedding, generation, vector store, and sandbox host ports). A
   * missing service fails closed with a stable typed graph execution error.
   *
   * @param {GraphNodeExecutionRequest<AgentVectorStoreInput>} request - Execution request.
   * @return {Promise<GraphExecutionValues>} The node outputs.
   */
  override async execute(
    request: GraphNodeExecutionRequest<AgentVectorStoreInput>
  ): Promise<GraphExecutionValues> {
    const provider = this.provider ?? "memory";
    if (this.embedding !== undefined) {
      assertNoMastraPlainConnectionCredentials(this.embedding, {
        provider,
        id: this.storeId ?? this.indexName ?? provider,
        surface: "vector store embedding",
      });
    }
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

  /** The selected vector-store provider. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.vector_store.fields.provider.label",
    type: "select",
  })
  @input({ handle: "provider", userControlled: true })
  provider?:
    | "memory"
    | "pgvector"
    | "redis"
    | "upstash"
    | "age"
    | "graph"
    | "qdrant"
    | "pinecone"
    | "supabase"
    | "mongodb"
    | "libsql"
    | "chroma";

  /** Optional store id (defaults to the index name / provider). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.vector_store.fields.storeId.label",
    type: "text",
  })
  @input({ handle: "storeId", userControlled: true })
  storeId?: string;

  /** The index/collection name within the store. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.vector_store.fields.indexName.label",
    type: "text",
  })
  @input({ handle: "indexName", userControlled: true })
  indexName?: string;

  /** The embedding dimension the index is created with. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.vector_store.fields.dimension.label",
    type: "number",
  })
  @input({ handle: "dimension", userControlled: true })
  dimension?: number;

  /** The similarity metric the index is created with. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.vector_store.fields.metric.label",
    type: "select",
  })
  @input({ handle: "metric", userControlled: true })
  metric?: "cosine" | "euclidean" | "dotproduct";

  /**
   * The embedding adapter carried in the store's own config (R1): the insert
   * path resolves it without requiring a separate embedding node.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.embedding.fields.modelAdapter.label",
    type: "object",
  })
  @input({ handle: "embedding", userControlled: true, type: "object" })
  embedding?: Record<string, unknown>;

  /** Provider connection options (never a plain secret; use `credentialRef`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.vector_store.fields.connection.label",
    type: "object",
  })
  @input({ handle: "connection", userControlled: true, type: "object" })
  connection?: Record<string, unknown>;

  /**
   * The `connection` member the resolved credential populates. Defaults to the
   * provider's native option name (`password` for pgvector/redis, `apiKey` for
   * the hosted stores); only used with `credentialRef`.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.vector_store.fields.credentialRef.label",
    type: "text",
  })
  @input({ handle: "credentialKey", userControlled: true })
  credentialKey?: string;

  /** Credential reference resolved by document validation stage 8 (never a secret). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.vector_store.fields.credentialRef.label",
    type: "object",
  })
  @input({ handle: "credentialRef", userControlled: true, type: "object" })
  credentialRef?: Record<string, unknown>;

  /** Output carrying the resolved mastra vector-store resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Output carrying the ids inserted into the store. */
  @output({ handle: "inserted" })
  insertedOut!: unknown;

  /** Output passing through the documents offered to the store. */
  @output({ handle: "documents" })
  documentsOut!: unknown;
}

/** All built-in vector-store node constructors. */
export const GRAPH_AGENT_VECTOR_STORE_NODES = [AgentVectorStoreNode] as const;
