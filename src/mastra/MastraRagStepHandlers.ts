/**
 * @module as-graph/mastra/MastraRagStepHandlers
 * @summary Real RAG execution for the mastra engine (SAA-747 Stage 2).
 * @description Implements the RAG family as real `@mastra/core` workflow steps
 * on top of the mastra-native vector/embedding/model bindings: the vector-store
 * step creates its index and inserts embedded documents (or queries it when a
 * query is supplied), the retriever embeds the query and reads the wired store,
 * the three chains generate through a mastra agent, the structured-output
 * parser/information extractor parse and validate model output, and the LangChain
 * Code/Sandbox kinds run user code through a host sandbox runner with the same
 * ceiling guard as the verified `CodeNode`.
 *
 * The nodes keep their config-only descriptor projection (R9) as the fallback:
 * when a host has not supplied the corresponding execution surface (or the node
 * carries no work), the step emits the JSON-safe `kind` descriptor exactly like
 * the default handler set. Real execution is selected only when the document
 * wires the inputs the kind needs, so an authored config-only node never makes a
 * model or database call by accident.
 *
 * Embedding and text generation are carried as **config** on the node (R1):
 * `embedding`/`modelAdapter` objects with `provider`/`modelId` (and an optional
 * credential reference). The default paths use mastra's own
 * `ModelRouterEmbeddingModel` and `Agent` bindings; a host may inject
 * `embedText`/`generateText` ports (deterministic tests, custom providers)
 * without changing the graph document. Every path fails closed with a typed
 * error rather than fabricating vectors, answers, or code results.
 */
import { Agent } from "@mastra/core/agent";
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import type { MastraVector, VectorFilter } from "@mastra/core/vector";
import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import { GRAPH_CODE_MAX_TIMEOUT_MS } from "../engine/constants";
import { clampGraphCodeTimeoutMs } from "../node/utility/code/node";
import {
  isGraphCredentialReference,
  type GraphCredentialReference,
} from "../shared/graph/catalog/GraphCredentialReference";
import {
  graphModelAdapterOf,
  type MastraModelAdapterConfig,
} from "./MastraAgentModelAdapter";
import {
  mastraVectorStoreConfigOf,
  resolveMastraVectorStore,
  type MastraVectorStoreBindings,
  type MastraVectorStoreConfig,
  type MastraVectorStoreDescriptor,
  type MastraVectorStoreDrivers,
  type ResolvedMastraVectorStore,
} from "./MastraVectorStore";
import {
  GRAPH_MASTRA_EMBEDDING_UNAVAILABLE,
  GRAPH_MASTRA_RAG_UNAVAILABLE,
  GRAPH_MASTRA_SANDBOX_TIMEOUT,
  GRAPH_MASTRA_SANDBOX_UNAVAILABLE,
  GRAPH_MASTRA_VECTOR_PROVIDER_UNKNOWN,
  type MastraNodeStepHandler,
  type MastraNodeStepOptions,
} from "./types";

/** The RAG node kinds this handler set executes. */
export const MASTRA_RAG_EXECUTION_KINDS = [
  "core.agent.embedding",
  "core.agent.vectorStore",
  "core.agent.retriever",
  "core.agent.chain.qa",
  "core.agent.chain.basic",
  "core.agent.chain.summarization",
  "core.agent.structuredOutputParser",
  "core.agent.informationExtractor",
] as const;

/** The sandbox/code kinds this handler set executes. */
export const MASTRA_SANDBOX_EXECUTION_KINDS = [
  "core.agent.sandbox",
  "core.agent.langchainCode",
] as const;

/** A mastra embedding binding carried as node config (R1). */
export interface MastraEmbeddingConfig {
  /** The embedding provider (e.g. `openai`, `google`). */
  provider: string;
  /** The provider-specific embedding model id. */
  modelId: string;
  /** Optional credential reference validated by document validation stage 8. */
  credentialRef?: GraphCredentialReference;
  /** The vector dimension the model produces. */
  dimension?: number;
  /** Optional batch size for embedding requests. */
  batchSize?: number;
}

/**
 * Host embedding port. Receives the texts and the node's embedding config and
 * returns one vector per text. A host implementation may call any provider; the
 * default uses mastra's `ModelRouterEmbeddingModel`.
 */
export type MastraRagEmbedder = (request: {
  values: string[];
  config: MastraEmbeddingConfig;
  node: GraphNodeInstance;
}) => Promise<number[][]>;

/** One text-generation request handed to the host generator port. */
export interface MastraRagTextRequest {
  /** The chain node being executed. */
  node: GraphNodeInstance;
  /** The node's model-adapter config (provider/modelId/credential reference). */
  modelAdapter?: MastraModelAdapterConfig;
  /** System instructions for the generation. */
  instructions?: string;
  /** The user prompt. */
  prompt: string;
  /** The run's abort signal, when available. */
  abortSignal?: AbortSignal;
}

/** The text (and optional structured object) a generation produced. */
export interface MastraRagTextResult {
  /** The generated text. */
  text: string;
  /** The parsed structured object, when the generator produced one. */
  object?: unknown;
}

/** Host text-generation port used by the chains and the extractor. */
export type MastraRagTextGenerator = (
  request: MastraRagTextRequest
) => Promise<MastraRagTextResult>;

/** One sandboxed code-execution request. */
export interface MastraSandboxRunRequest {
  /** The node executing the code. */
  node: GraphNodeInstance;
  /** The user-authored code. */
  code: string;
  /** The code language. */
  language: "javascript" | "typescript";
  /** The value bound to the code's input. */
  input: unknown;
  /** The ceiling-clamped timeout in milliseconds. */
  timeoutMs: number;
  /** The requested isolation mode, when configured. */
  isolation?: string;
  /** The requested working directory, when configured. */
  workingDirectory?: string;
}

/** Host sandbox runner port executing the code under the requested bounds. */
export type MastraSandboxRunner = (
  request: MastraSandboxRunRequest
) => Promise<unknown>;

/** Options the RAG/sandbox handler set is built with. */
export interface MastraRagStepHandlerOptions {
  /** Mastra-native vector-store bindings (`pgvector`, `redis`). */
  vectorStoreBindings?: MastraVectorStoreBindings;
  /** Custom vector-store drivers (`age`, `graph`). */
  vectorStoreDrivers?: MastraVectorStoreDrivers;
  /** Optional override of the live vector-store resolution. */
  resolveVectorStore?: (
    config: MastraVectorStoreConfig
  ) => ResolvedMastraVectorStore | Promise<ResolvedMastraVectorStore>;
  /** Host embedding port; defaults to mastra's `ModelRouterEmbeddingModel`. */
  embedText?: MastraRagEmbedder;
  /** Host generation port; defaults to a mastra `Agent` over the adapter config. */
  generateText?: MastraRagTextGenerator;
  /** Host sandbox runner; when omitted code kinds fail closed. */
  runSandboxedCode?: MastraSandboxRunner;
  /**
   * Backend-wide embedding config used when a document does not carry one on
   * the embedding/vector-store node. Hosts that author RAG documents without a
   * dedicated `core.agent.embedding` node set this once.
   */
  embedding?: MastraEmbeddingConfig;
  /**
   * Live vector-store cache. Shared across the handler set so an in-memory store
   * inserted by the vector-store step is the same instance the retriever reads.
   * A host may pass its own cache to share across compilations.
   */
  storeCache?: Map<string, MastraVector>;
}

/** Default number of documents a vector-store query returns. */
const DEFAULT_TOP_K = 4;
/** Default number of texts embedded per embedding request. */
const DEFAULT_BATCH_SIZE = 64;

/**
 * Type guard accepting plain, non-array objects only.
 *
 * @param value - The value to test.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Coerces an unknown value to a record, returning `{}` for anything else. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Returns the value when it is a non-blank string, else `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** Returns the value floored when it is a positive finite integer, else `undefined`. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Reads the embedding config a node carries (R1). Looks at the dedicated
 * `embedding` parameter first, then a `modelAdapter` (the embedding node uses
 * that handle), and finally root `provider`/`modelId` fields. Returns
 * `undefined` when no usable provider/model pair is present, so a config-only
 * node never triggers an embedding call.
 *
 * @param node - The canonical node instance.
 * @returns The validated embedding config, or `undefined`.
 */
export function mastraEmbeddingConfigOf(
  node: GraphNodeInstance
): MastraEmbeddingConfig | undefined {
  return mastraEmbeddingConfigOfRecord(node.parameters);
}

/**
 * Reads an embedding config carried by a runtime input value (a data edge can
 * feed the embedding model config into an insert/retrieval step). Returns
 * `undefined` when the value is not a usable provider/model pair.
 *
 * @param value - The runtime input value.
 * @returns The validated embedding config, or `undefined`.
 */
function mastraEmbeddingConfigOfInput(
  value: unknown
): MastraEmbeddingConfig | undefined {
  return mastraEmbeddingConfigOfRecord(value);
}

/**
 * Shared reader behind {@link mastraEmbeddingConfigOf} and
 * {@link mastraEmbeddingConfigOfInput}. Probes the candidate handles in order
 * and validates the first usable provider/model pair it finds.
 *
 * @param value - The record to read the embedding config from.
 * @returns The validated embedding config, or `undefined`.
 */
function mastraEmbeddingConfigOfRecord(
  value: unknown
): MastraEmbeddingConfig | undefined {
  const parameters = asRecord(value);
  const candidates = [
    parameters["embedding"],
    parameters["modelAdapter"],
    parameters,
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const provider = nonEmptyString(candidate["provider"]);
    const modelId = nonEmptyString(candidate["modelId"]);
    if (!provider || !modelId) continue;
    const config: MastraEmbeddingConfig = { provider, modelId };
    const credentialRef = candidate["credentialRef"];
    if (credentialRef !== undefined) {
      if (!isGraphCredentialReference(credentialRef)) continue;
      config.credentialRef = credentialRef;
    }
    const dimension = positiveInteger(candidate["dimension"]);
    if (dimension !== undefined) config.dimension = dimension;
    const batchSize = positiveInteger(candidate["batchSize"]);
    if (batchSize !== undefined) config.batchSize = batchSize;
    return config;
  }
  return undefined;
}

/** The deterministic, secret-free document id used for a fallback descriptor. */
function descriptorFallback(
  node: GraphNodeInstance,
  inputData: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...inputData,
    ...extra,
    resource: {
      kind: node.kind,
      nodeId: node.id,
      parameters: asRecord(node.parameters),
      ...(isRecord(extra["resource"]) ? extra["resource"] : {}),
    },
  };
}

/**
 * Finds the node wired as the source of a data edge into `targetPort`. Used by
 * the retriever to resolve the vector-store provider node it reads from.
 *
 * @param document - The document being compiled, when available.
 * @param targetNodeId - The consuming node id.
 * @param targetPort - The consumer input port.
 * @returns The source node, or `undefined` when no data edge matches.
 */
function sourceNodeOf(
  document: GraphWorkflowDocument | undefined,
  targetNodeId: string,
  targetPort: string
): GraphNodeInstance | undefined {
  if (!document) return undefined;
  const byId = new Map((document.nodes ?? []).map((n) => [n.id, n]));
  for (const edge of document.edges ?? []) {
    if (edge.type !== "data") continue;
    if (
      edge.target.scope === "node" &&
      edge.target.nodeId === targetNodeId &&
      edge.target.port === targetPort &&
      edge.source.scope === "node"
    ) {
      return byId.get(edge.source.nodeId);
    }
  }
  return undefined;
}

/** The texts/metadata extracted from a documents input. */
interface DocumentTexts {
  texts: string[];
  metadata: Record<string, unknown>[];
}

/**
 * Normalizes a `documents` value (strings or `{ text, metadata }` objects) into
 * the parallel text/metadata arrays a vector upsert needs. Entries without a
 * usable text are skipped.
 *
 * @param documents - The raw documents input.
 * @returns The normalized texts and metadata.
 */
export function documentTextsOf(documents: unknown): DocumentTexts {
  const texts: string[] = [];
  const metadata: Record<string, unknown>[] = [];
  if (!Array.isArray(documents)) return { texts, metadata };
  for (const entry of documents) {
    let text: string | undefined;
    let meta: Record<string, unknown> = {};
    if (typeof entry === "string") {
      text = entry;
    } else if (isRecord(entry)) {
      text =
        nonEmptyString(entry["text"]) ??
        nonEmptyString(entry["content"]) ??
        nonEmptyString(entry["pageContent"]);
      meta = isRecord(entry["metadata"]) ? { ...entry["metadata"] } : {};
    }
    if (!text) continue;
    texts.push(text);
    metadata.push({ ...meta, text });
  }
  return { texts, metadata };
}

/** Extracts the text from a query/prompt input, accepting strings or records. */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    return (
      nonEmptyString(value["query"]) ??
      nonEmptyString(value["text"]) ??
      nonEmptyString(value["input"])
    );
  }
  return undefined;
}

/** Interpolates `{{ input }}`/`{{ query }}`/`{{ context }}` in a template. */
function interpolate(
  template: string,
  values: Record<string, unknown>
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in values ? String(values[key] ?? "") : match
  );
}

/**
 * The default mastra-native embedding path. Builds a
 * `ModelRouterEmbeddingModel` from `provider/modelId`, embeds the batch, and
 * fails closed with {@link GRAPH_MASTRA_EMBEDDING_UNAVAILABLE} when the model
 * returns no embeddings.
 *
 * @param {object} request - The embedding request.
 * @param {string[]} request.values - The texts to embed.
 * @param {MastraEmbeddingConfig} request.config - The node's embedding config.
 * @param {GraphNodeInstance} request.node - The canonical node instance.
 * @returns {Promise.<number[][]>} One vector per input text, in order.
 */
async function defaultEmbed(
  request: Parameters<MastraRagEmbedder>[0]
): Promise<number[][]> {
  const { config, values } = request;
  if (!values.length) return [];
  try {
    const model = new ModelRouterEmbeddingModel(
      `${config.provider}/${config.modelId}`
    );
    const result = (await model.doEmbed({ values })) as {
      embeddings?: number[][];
    };
    if (!Array.isArray(result?.embeddings)) {
      throw new Error("embedding model returned no embeddings");
    }
    return result.embeddings;
  } catch (error) {
    throw new GraphExecutionError(
      `Embedding model '${config.provider}/${config.modelId}' failed for node '${request.node.id}': ${String(error)}`,
      GRAPH_MASTRA_EMBEDDING_UNAVAILABLE,
      {
        nodeId: request.node.id,
        provider: config.provider,
        modelId: config.modelId,
      }
    );
  }
}

/** The default mastra-native generation path. */
async function defaultGenerate(
  request: MastraRagTextRequest
): Promise<MastraRagTextResult> {
  const adapter = request.modelAdapter;
  if (!adapter) {
    throw new GraphExecutionError(
      `Chain node '${request.node.id}' has no modelAdapter config, so no mastra agent can be built`,
      GRAPH_MASTRA_RAG_UNAVAILABLE,
      { nodeId: request.node.id }
    );
  }
  try {
    const AgentCtor = Agent as unknown as new (
      options: Record<string, unknown>
    ) => {
      generate: (
        prompt: string,
        options?: Record<string, unknown>
      ) => Promise<{ text?: unknown; response?: unknown; object?: unknown }>;
    };
    const agent = new AgentCtor({
      name: `graph-${request.node.id}`,
      instructions: request.instructions ?? "",
      model: `${adapter.provider}/${adapter.modelId}`,
    });
    const result = await agent.generate(
      request.prompt,
      request.abortSignal ? { abortSignal: request.abortSignal } : undefined
    );
    const text =
      typeof result?.text === "string"
        ? result.text
        : typeof result?.response === "string"
          ? result.response
          : "";
    return result?.object !== undefined
      ? { text, object: result.object }
      : { text };
  } catch (error) {
    throw new GraphExecutionError(
      `Chain node '${request.node.id}' generation failed on '${adapter.provider}/${adapter.modelId}': ${String(error)}`,
      GRAPH_MASTRA_RAG_UNAVAILABLE,
      { nodeId: request.node.id }
    );
  }
}

/** Parses JSON text, returning `undefined` for invalid/empty input. */
function parseJsonObject(text: unknown): unknown {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(withoutFence);
  } catch {
    return undefined;
  }
}

/** Runs a promise with a hard timeout, clearing the timer on settle. */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  nodeId: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new GraphExecutionError(
          `Sandboxed code on node '${nodeId}' exceeded its ${timeoutMs}ms ceiling`,
          GRAPH_MASTRA_SANDBOX_TIMEOUT,
          { nodeId, timeoutMs }
        )
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The effective index name for a vector-store config. */
function indexNameOf(
  config: MastraVectorStoreConfig | undefined,
  fallback: string | undefined
): string {
  return (
    config?.indexName ??
    nonEmptyString(fallback) ??
    config?.id ??
    "default"
  );
}

/**
 * Builds the real RAG/sandbox step handler set. Handlers are registered by the
 * backend after the host default set, so they override the config-only
 * pass-through for the kinds they implement while leaving the fallback output
 * identical when no real execution applies.
 *
 * @param options - Host ports (embeddings, generation, sandbox) and bindings.
 * @returns One {@link MastraNodeStepHandler} per executed kind.
 */
export function createMastraRagStepHandlers(
  options: MastraRagStepHandlerOptions = {}
): MastraNodeStepHandler[] {
  const storeCache = options.storeCache ?? new Map<string, MastraVector>();
  const embedder: MastraRagEmbedder = options.embedText ?? defaultEmbed;
  const generator: MastraRagTextGenerator =
    options.generateText ?? defaultGenerate;

  const resolveStore = async (
    config: MastraVectorStoreConfig
  ): Promise<ResolvedMastraVectorStore> => {
    const resolved = options.resolveVectorStore
      ? await options.resolveVectorStore(config)
      : resolveMastraVectorStore(config, {
          ...(options.vectorStoreBindings
            ? { bindings: options.vectorStoreBindings }
            : {}),
          ...(options.vectorStoreDrivers
            ? { drivers: options.vectorStoreDrivers }
            : {}),
        });
    const key = `${resolved.descriptor.provider}:${resolved.descriptor.id}:${resolved.descriptor.indexName ?? ""}`;
    const cached = storeCache.get(key);
    if (cached) return { store: cached, descriptor: resolved.descriptor };
    storeCache.set(key, resolved.store);
    return resolved;
  };

  const liveStoreOf = async (
    descriptor: MastraVectorStoreDescriptor
  ): Promise<MastraVector> => {
    const key = `${descriptor.provider}:${descriptor.id}:${descriptor.indexName ?? ""}`;
    const cached = storeCache.get(key);
    if (cached) return cached;
    const { store } = await resolveStore({
      provider: descriptor.provider,
      ...(descriptor.id ? { id: descriptor.id } : {}),
      ...(descriptor.indexName ? { indexName: descriptor.indexName } : {}),
      ...(descriptor.dimension !== undefined
        ? { dimension: descriptor.dimension }
        : {}),
      ...(descriptor.metric ? { metric: descriptor.metric } : {}),
      ...(descriptor.credentialRef
        ? { credentialRef: descriptor.credentialRef }
        : {}),
    });
    storeCache.set(key, store);
    return store;
  };

  const ensureIndex = async (
    store: MastraVector,
    indexName: string,
    dimension: number,
    metric: MastraVectorStoreConfig["metric"]
  ): Promise<void> => {
    const indexes = await store.listIndexes();
    if (indexes.includes(indexName)) return;
    await store.createIndex({
      indexName,
      dimension,
      ...(metric ? { metric } : {}),
    });
  };

  const embedValues = async (
    node: GraphNodeInstance,
    values: string[],
    config: MastraEmbeddingConfig
  ): Promise<number[][]> => {
    const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    const vectors: number[][] = [];
    for (let start = 0; start < values.length; start += batchSize) {
      const batch = values.slice(start, start + batchSize);
      const embedded = await embedder({ values: batch, config, node });
      if (
        !Array.isArray(embedded) ||
        embedded.length !== batch.length ||
        embedded.some(
          (vector) =>
            !Array.isArray(vector) ||
            vector.some((value) => typeof value !== "number")
        )
      ) {
        throw new GraphExecutionError(
          `Embedding port returned an invalid vector batch for node '${node.id}'`,
          GRAPH_MASTRA_EMBEDDING_UNAVAILABLE,
          { nodeId: node.id, expected: batch.length }
        );
      }
      vectors.push(...embedded);
    }
    return vectors;
  };

  const handlers: MastraNodeStepHandler[] = [];

  const handler = (
    kind: string,
    execute: (
      node: GraphNodeInstance,
      inputData: Record<string, unknown>,
      document: GraphWorkflowDocument | undefined,
      signal?: AbortSignal
    ) => Promise<Record<string, unknown>>
  ): void => {
    handlers.push({
      kind,
      createStep: (node, stepOptions: MastraNodeStepOptions) =>
        createStep({
          id: stepOptions.stepId,
          inputSchema: z.any(),
          outputSchema: z.any(),
          execute: async (args: {
            inputData?: unknown;
            abortSignal?: AbortSignal;
          }) => {
            const inputData = asRecord(args.inputData);
            return execute(
              node,
              inputData,
              stepOptions.document,
              args.abortSignal
            );
          },
        }),
    });
  };

  // --- embedding ---------------------------------------------------------

  handler("core.agent.embedding", async (node, inputData) => {
    const config = mastraEmbeddingConfigOf(node) ?? options.embedding;
    const input = inputData["values"] ?? inputData["input"] ?? inputData["text"];
    const values = Array.isArray(input)
      ? input.filter((entry): entry is string => typeof entry === "string")
      : typeof input === "string"
        ? [input]
        : [];
    if (!config || values.length === 0) {
      return descriptorFallback(node, inputData, {
        resource: {
          type: "mastra.embedding",
          provider: config?.provider,
          modelId: config?.modelId,
          dimension: config?.dimension,
          batchSize: config?.batchSize,
        },
      });
    }
    const vectors = await embedValues(node, values, config);
    return {
      ...inputData,
      vectors,
      resource: {
        kind: node.kind,
        nodeId: node.id,
        type: "mastra.embedding",
        provider: config.provider,
        modelId: config.modelId,
        dimension: config.dimension ?? vectors[0]?.length,
        batchSize: config.batchSize,
      },
    };
  });

  // --- vector store ------------------------------------------------------

  handler("core.agent.vectorStore", async (node, inputData) => {
    const parameters = asRecord(node.parameters);
    const rawConfig = mastraVectorStoreConfigOf(node);
    if (!rawConfig) {
      const nested = parameters["vectorStore"];
      const declared = isRecord(nested)
        ? nested["provider"] ?? parameters["provider"]
        : parameters["provider"];
      if (nested !== undefined || declared !== undefined) {
        throw new GraphExecutionError(
          `Vector-store node '${node.id}' declares an unknown or malformed vector-store config`,
          GRAPH_MASTRA_VECTOR_PROVIDER_UNKNOWN,
          {
            nodeId: node.id,
            provider:
              declared === undefined ? undefined : String(declared),
          }
        );
      }
    }
    const raw = rawConfig ?? { provider: "memory" };
    const embedding =
      mastraEmbeddingConfigOfInput(raw.embedding) ??
      mastraEmbeddingConfigOf(node) ??
      mastraEmbeddingConfigOfInput(inputData["embedding"]) ??
      mastraEmbeddingConfigOfInput(inputData["modelAdapter"]) ??
      options.embedding;
    const indexName = indexNameOf(raw, parameters["indexName"] as string);
    const documents = inputData["documents"] ?? parameters["documents"];
    const { texts, metadata } = documentTextsOf(documents);
    const queryText = textOf(
      inputData["query"] ?? parameters["query"]
    );
    const queryVector = Array.isArray(inputData["queryVector"])
      ? (inputData["queryVector"] as number[])
      : Array.isArray(parameters["queryVector"])
        ? (parameters["queryVector"] as number[])
        : undefined;

    const descriptorBase: Record<string, unknown> = {
      kind: node.kind,
      nodeId: node.id,
      type: "mastra.vectorStore",
      provider: raw.provider,
      id: raw.id ?? raw.indexName ?? raw.provider,
      indexName,
      ...(raw.dimension !== undefined ? { dimension: raw.dimension } : {}),
      ...(raw.metric !== undefined ? { metric: raw.metric } : {}),
      ...(raw.credentialRef ? { credentialRef: raw.credentialRef } : {}),
      ...(embedding
        ? {
            embedding: {
              provider: embedding.provider,
              modelId: embedding.modelId,
              ...(embedding.dimension !== undefined
                ? { dimension: embedding.dimension }
                : {}),
              ...(embedding.batchSize !== undefined
                ? { batchSize: embedding.batchSize }
                : {}),
            },
          }
        : {}),
    };

    const wantsInsert = texts.length > 0;
    const wantsQuery = queryText !== undefined || queryVector !== undefined;
    if (!wantsInsert && !wantsQuery) {
      return {
        ...inputData,
        resource: descriptorBase,
        inserted: Array.isArray(inputData["ids"]) ? inputData["ids"] : [],
        documents: Array.isArray(documents) ? documents : [],
      };
    }

    const resolved = await resolveStore(raw);
    const store = resolved.store;

    if (wantsInsert) {
      if (!embedding) {
        throw new GraphExecutionError(
          `Vector-store node '${node.id}' has documents to insert but no embedding config`,
          GRAPH_MASTRA_EMBEDDING_UNAVAILABLE,
          { nodeId: node.id }
        );
      }
      const vectors = await embedValues(node, texts, embedding);
      const dimension = raw.dimension ?? vectors[0]?.length;
      if (!dimension) {
        throw new GraphExecutionError(
          `Vector-store node '${node.id}' could not resolve the index dimension`,
          GRAPH_MASTRA_RAG_UNAVAILABLE,
          { nodeId: node.id }
        );
      }
      await ensureIndex(store, indexName, dimension, raw.metric);
      const ids = Array.isArray(inputData["ids"])
        ? (inputData["ids"] as unknown[]).map((id) => String(id))
        : texts.map((_, index) => `${node.id}-${index}`);
      const inserted = await store.upsert({
        indexName,
        vectors,
        ids,
        metadata,
      });
      return {
        ...inputData,
        resource: { ...descriptorBase, dimension },
        inserted,
        documents: Array.isArray(documents) ? documents : [],
      };
    }

    const queryEmbedding =
      queryVector ??
      (await embedValues(node, [queryText as string], embedding!))[0];
    const results = await store.query({
      indexName,
      queryVector: queryEmbedding,
      topK: positiveInteger(inputData["topK"] ?? parameters["topK"]) ?? DEFAULT_TOP_K,
      ...(isRecord(inputData["filter"] ?? parameters["filter"])
        ? {
            filter: (inputData["filter"] ??
              parameters["filter"]) as VectorFilter,
          }
        : {}),
    });
    return {
      ...inputData,
      resource: descriptorBase,
      documents: results.map((result) => ({
        id: result.id,
        score: result.score,
        text:
          nonEmptyString(result.metadata?.["text"]) ??
          result.document ??
          "",
        metadata: result.metadata ?? {},
      })),
    };
  });

  // --- retriever ---------------------------------------------------------

  handler("core.agent.retriever", async (node, inputData, document) => {
    const parameters = asRecord(node.parameters);
    const source = sourceNodeOf(document, node.id, "store");
    const sourceConfig = source ? mastraVectorStoreConfigOf(source) : undefined;
    const embedding =
      (source ? mastraEmbeddingConfigOf(source) : undefined) ??
      mastraEmbeddingConfigOf(node) ??
      mastraEmbeddingConfigOfInput(inputData["embedding"]) ??
      mastraEmbeddingConfigOfInput(inputData["modelAdapter"]) ??
      options.embedding;
    const descriptor = isRecord(inputData["store"])
      ? (inputData["store"] as unknown as MastraVectorStoreDescriptor)
      : undefined;
    const indexName = indexNameOf(
      sourceConfig,
      nonEmptyString(parameters["indexName"]) ?? descriptor?.indexName
    );
    const queryText = textOf(
      inputData["query"] ?? parameters["query"]
    );
    const queryVector = Array.isArray(inputData["queryVector"])
      ? (inputData["queryVector"] as number[])
      : undefined;

    if (
      (!sourceConfig && !descriptor) ||
      (queryText === undefined && queryVector === undefined)
    ) {
      return descriptorFallback(node, inputData, {
        documents: Array.isArray(inputData["documents"])
          ? inputData["documents"]
          : [],
        resource: {
          type: "mastra.retriever",
          topK: positiveInteger(parameters["topK"]),
          indexName,
          store: inputData["store"],
        },
      });
    }

    const store = sourceConfig
      ? (await resolveStore(sourceConfig)).store
      : await liveStoreOf(descriptor!);
    if (queryText !== undefined && queryVector === undefined && !embedding) {
      throw new GraphExecutionError(
        `Retriever node '${node.id}' has a text query but no embedding config on the wired vector store`,
        GRAPH_MASTRA_EMBEDDING_UNAVAILABLE,
        { nodeId: node.id }
      );
    }
    const vector =
      queryVector ??
      (await embedValues(node, [queryText as string], embedding!))[0];
    const results = await store.query({
      indexName,
      queryVector: vector,
      topK: positiveInteger(parameters["topK"]) ?? DEFAULT_TOP_K,
      ...(isRecord(parameters["filter"])
        ? { filter: parameters["filter"] as VectorFilter }
        : {}),
    });
    const documents = results.map((result) => ({
      id: result.id,
      score: result.score,
      text:
        nonEmptyString(result.metadata?.["text"]) ??
        result.document ??
        "",
      metadata: result.metadata ?? {},
    }));
    return {
      ...inputData,
      documents,
      resource: {
        kind: node.kind,
        nodeId: node.id,
        type: "mastra.retriever",
        topK: positiveInteger(parameters["topK"]) ?? DEFAULT_TOP_K,
        indexName,
        store:
          descriptor ??
          (sourceConfig
            ? {
                type: "mastra.vectorStore",
                provider: sourceConfig.provider,
                id:
                  sourceConfig.id ??
                  sourceConfig.indexName ??
                  sourceConfig.provider,
                indexName,
              }
            : undefined),
        embedding: embedding
          ? { provider: embedding.provider, modelId: embedding.modelId }
          : undefined,
      },
    };
  });

  // --- chains ------------------------------------------------------------

  handler("core.agent.chain.basic", async (node, inputData, _document, signal) => {
    const parameters = asRecord(node.parameters);
    const adapter = graphModelAdapterOf(node);
    const input =
      textOf(inputData["input"] ?? inputData["text"] ?? parameters["input"]) ??
      "";
    const template = nonEmptyString(parameters["promptTemplate"]);
    const prompt = template ? interpolate(template, { input }) : input;
    if (!adapter || prompt.length === 0) {
      return descriptorFallback(node, inputData, {
        text: typeof inputData["text"] === "string" ? inputData["text"] : "",
        resource: {
          type: "mastra.chain.basic",
          provider: adapter?.provider,
          modelId: adapter?.modelId,
          promptTemplate: parameters["promptTemplate"],
        },
      });
    }
    const result = await generator({
      node,
      modelAdapter: adapter,
      prompt,
      ...(signal ? { abortSignal: signal } : {}),
    });
    return {
      ...inputData,
      text: result.text,
      resource: {
        kind: node.kind,
        nodeId: node.id,
        type: "mastra.chain.basic",
        provider: adapter.provider,
        modelId: adapter.modelId,
        promptTemplate: parameters["promptTemplate"],
      },
    };
  });

  handler("core.agent.chain.qa", async (node, inputData, _document, signal) => {
    const parameters = asRecord(node.parameters);
    const adapter = graphModelAdapterOf(node);
    const question =
      textOf(inputData["query"] ?? inputData["input"] ?? parameters["query"]) ??
      "";
    const contextValue = inputData["context"] ?? inputData["documents"];
    const contextDocuments = Array.isArray(contextValue)
      ? contextValue
      : contextValue !== undefined
        ? [contextValue]
        : [];
    const contextText = contextDocuments
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (isRecord(entry)) return textOf(entry) ?? "";
        return "";
      })
      .filter((entry) => entry.length > 0)
      .join("\n\n");
    const template = nonEmptyString(parameters["promptTemplate"]);
    const prompt = template
      ? interpolate(template, { query: question, context: contextText })
      : `Use the context below to answer the question.\n\nContext:\n${contextText}\n\nQuestion: ${question}\n\nAnswer:`;
    if (!adapter || question.length === 0) {
      return descriptorFallback(node, inputData, {
        text: typeof inputData["text"] === "string" ? inputData["text"] : "",
        sourceDocuments: parameters["returnSourceDocuments"]
          ? contextDocuments
          : [],
        resource: {
          type: "mastra.chain.qa",
          provider: adapter?.provider,
          modelId: adapter?.modelId,
          returnSourceDocuments: parameters["returnSourceDocuments"] ?? false,
        },
      });
    }
    const result = await generator({
      node,
      modelAdapter: adapter,
      prompt,
      ...(signal ? { abortSignal: signal } : {}),
    });
    return {
      ...inputData,
      text: result.text,
      sourceDocuments: parameters["returnSourceDocuments"]
        ? contextDocuments
        : [],
      resource: {
        kind: node.kind,
        nodeId: node.id,
        type: "mastra.chain.qa",
        provider: adapter.provider,
        modelId: adapter.modelId,
        returnSourceDocuments: parameters["returnSourceDocuments"] ?? false,
      },
    };
  });

  handler(
    "core.agent.chain.summarization",
    async (node, inputData, _document, signal) => {
      const parameters = asRecord(node.parameters);
      const adapter = graphModelAdapterOf(node);
      const { texts } = documentTextsOf(
        inputData["documents"] ?? parameters["documents"]
      );
      const instructions =
        nonEmptyString(parameters["instructions"]) ??
        "Summarize the following documents concisely.";
      if (!adapter || texts.length === 0) {
        return descriptorFallback(node, inputData, {
          text: typeof inputData["text"] === "string" ? inputData["text"] : "",
          resource: {
            type: "mastra.chain.summarization",
            provider: adapter?.provider,
            modelId: adapter?.modelId,
            strategy: parameters["strategy"] ?? "stuff",
            documentCount: texts.length,
          },
        });
      }
      const result = await generator({
        node,
        modelAdapter: adapter,
        instructions,
        prompt: texts.join("\n\n---\n\n"),
        ...(signal ? { abortSignal: signal } : {}),
      });
      return {
        ...inputData,
        text: result.text,
        resource: {
          kind: node.kind,
          nodeId: node.id,
          type: "mastra.chain.summarization",
          provider: adapter.provider,
          modelId: adapter.modelId,
          strategy: parameters["strategy"] ?? "stuff",
          documentCount: texts.length,
        },
      };
    }
  );

  // --- structured output / extractor ------------------------------------

  handler("core.agent.structuredOutputParser", async (node, inputData) => {
    const text = inputData["text"] ?? inputData["input"];
    const object = parseJsonObject(text);
    return {
      ...inputData,
      object: object ?? null,
      resource: {
        kind: node.kind,
        nodeId: node.id,
        type: "mastra.structuredOutputParser",
        strict: asRecord(node.parameters)["strict"] ?? false,
        hasSchema: asRecord(node.parameters)["structuredOutput"] !== undefined,
      },
    };
  });

  handler(
    "core.agent.informationExtractor",
    async (node, inputData, _document, signal) => {
      const parameters = asRecord(node.parameters);
      const adapter = graphModelAdapterOf(node);
      const text = textOf(inputData["text"] ?? parameters["text"]);
      if (!adapter || !text) {
        return descriptorFallback(node, inputData, {
          data: inputData["data"] ?? null,
          resource: {
            type: "mastra.informationExtractor",
            provider: adapter?.provider,
            modelId: adapter?.modelId,
            instructions: parameters["instructions"],
            hasSchema: parameters["structuredOutput"] !== undefined,
          },
        });
      }
      const instructions =
        nonEmptyString(parameters["instructions"]) ??
        "Extract the requested structured information from the text and answer with a single JSON object.";
      const result = await generator({
        node,
        modelAdapter: adapter,
        instructions,
        prompt: text,
        ...(signal ? { abortSignal: signal } : {}),
      });
      const data =
        result.object ?? parseJsonObject(result.text) ?? null;
      return {
        ...inputData,
        data,
        resource: {
          kind: node.kind,
          nodeId: node.id,
          type: "mastra.informationExtractor",
          provider: adapter.provider,
          modelId: adapter.modelId,
          instructions: parameters["instructions"],
          hasSchema: parameters["structuredOutput"] !== undefined,
        },
      };
    }
  );

  // --- sandbox / LangChain Code -----------------------------------------

  const runCode = async (
    node: GraphNodeInstance,
    inputData: Record<string, unknown>,
    kind: "sandbox" | "langchainCode"
  ): Promise<Record<string, unknown>> => {
    const parameters = asRecord(node.parameters);
    const code = nonEmptyString(parameters["code"]);
    const timeoutMs = clampGraphCodeTimeoutMs(
      parameters["timeoutMs"],
      GRAPH_CODE_MAX_TIMEOUT_MS
    );
    if (!code) {
      return descriptorFallback(node, inputData, {
        ...(kind === "langchainCode"
          ? {
              output: inputData["input"] ?? null,
              resource: {
                type: "mastra.langchainCode",
                language: parameters["language"] ?? "javascript",
                mode: parameters["mode"] ?? "runOnce",
                hasCode: code !== undefined,
              },
            }
          : {
              resource: {
                type: "mastra.sandbox",
                workingDirectory: parameters["workingDirectory"],
                isolation: parameters["isolation"],
                timeoutMs,
              },
            }),
      });
    }
    if (!options.runSandboxedCode) {
      if (kind !== "langchainCode") {
        return descriptorFallback(node, inputData, {
          resource: {
            type: "mastra.sandbox",
            workingDirectory: parameters["workingDirectory"],
            isolation: parameters["isolation"],
            timeoutMs,
          },
        });
      }
      throw new GraphExecutionError(
        `Sandboxed code kind '${node.kind}' on node '${node.id}' has code but no host sandbox runner`,
        GRAPH_MASTRA_SANDBOX_UNAVAILABLE,
        { nodeId: node.id, kind: node.kind }
      );
    }
    const output = await withTimeout(
      Promise.resolve(
        options.runSandboxedCode({
          node,
          code,
          language:
            parameters["language"] === "typescript"
              ? "typescript"
              : "javascript",
          input: inputData["input"] ?? inputData,
          timeoutMs,
          ...(nonEmptyString(parameters["isolation"])
            ? { isolation: parameters["isolation"] as string }
            : {}),
          ...(nonEmptyString(parameters["workingDirectory"])
            ? { workingDirectory: parameters["workingDirectory"] as string }
            : {}),
        })
      ),
      timeoutMs,
      node.id
    );
    return descriptorFallback(node, inputData, {
      ...(kind === "langchainCode" ? { output } : { result: output }),
      resource: {
        type: kind === "langchainCode" ? "mastra.langchainCode" : "mastra.sandbox",
        timeoutMs,
      },
    });
  };

  handler("core.agent.sandbox", (node, inputData) =>
    runCode(node, inputData, "sandbox")
  );
  handler("core.agent.langchainCode", (node, inputData) =>
    runCode(node, inputData, "langchainCode")
  );

  return handlers;
}
