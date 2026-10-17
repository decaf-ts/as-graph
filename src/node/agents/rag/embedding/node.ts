/**
 * @module as-graph/nodes/agents/rag/embedding
 * @summary Mastra Embedding node declaration (SAA-836 M4).
 * @description Embedding node on the agent `embedding` zone. The embedding
 * model is carried as **config** (`modelAdapter`, R1 — there is no
 * model-provider node kind) and the node resolves it into the mastra embedding
 * resource on a real output port (R9). Connects only to the agent `embedding`
 * zone.
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
   * Resolves the embedding config into the mastra embedding resource descriptor.
   *
   * @param {GraphNodeExecutionRequest<AgentEmbeddingInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource` output value.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentEmbeddingInput>
  ): GraphExecutionValues {
    const adapter = (this.modelAdapter ?? {}) as Record<string, unknown>;
    return {
      resource: {
        type: "mastra.embedding",
        provider: adapter["provider"],
        modelId: adapter["modelId"],
        dimension: this.dimension,
        batchSize: this.batchSize,
        input: request.inputs,
      },
    };
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
