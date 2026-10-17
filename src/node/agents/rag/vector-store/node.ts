/**
 * @module as-graph/nodes/agents/rag/vector-store
 * @summary Mastra Vector Store node declaration (SAA-836 M4).
 * @description RAG vector-store backing node. It holds the **config** that
 * selects and describes a mastra vector store (provider, index, dimension,
 * metric, credential reference) and, per R9, resolves that config into the
 * mastra store resource on a real output port; the config-only fallback (the
 * descriptor alone) remains valid. Providers are `memory` (built-in in-memory
 * baseline), `pgvector` and `redis` (mastra-native bindings), and `age`/`graph`
 * (custom `MastraVector` stores over a host driver).
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
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
   * Resolves the vector-store config into the mastra store resource descriptor
   * (R9). The live `MastraVector` instance is resolved by the mastra
   * backend from this descriptor; the persisted output is the secret-free
   * descriptor.
   *
   * @param {GraphNodeExecutionRequest<AgentVectorStoreInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource`/`inserted`/`documents` outputs.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentVectorStoreInput>
  ): GraphExecutionValues {
    const provider = this.provider ?? "memory";
    const resource: Record<string, unknown> = {
      type: "mastra.vectorStore",
      provider,
      id: this.storeId ?? this.indexName ?? provider,
    };
    if (this.indexName !== undefined) resource["indexName"] = this.indexName;
    if (this.dimension !== undefined) resource["dimension"] = this.dimension;
    if (this.metric !== undefined) resource["metric"] = this.metric;
    if (this.credentialRef !== undefined) {
      resource["credentialRef"] = this.credentialRef;
    }
    const ids = request.inputs["ids"];
    return {
      resource,
      inserted: Array.isArray(ids) ? ids : [],
      documents: request.inputs["documents"] ?? [],
    };
  }

  /** The selected vector-store provider. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.vector_store.fields.provider.label",
    type: "select",
  })
  @input({ handle: "provider", userControlled: true })
  provider?: "memory" | "pgvector" | "redis" | "age" | "graph";

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

  /** Provider connection options (never a plain secret; use `credentialRef`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.vector_store.fields.connection.label",
    type: "object",
  })
  @input({ handle: "connection", userControlled: true, type: "object" })
  connection?: Record<string, unknown>;

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
