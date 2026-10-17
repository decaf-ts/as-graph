/**
 * @module as-graph/mastra/MastraVectorStore
 * @summary RAG vector-store layer for the mastra engine (SAA-836 M4).
 * @description The RAG vector-store node resolves its **config** into a live
 * `@mastra/core` {@link MastraVector} store, selecting a provider by config
 * (memory, pgvector, redis, age, graph). Mastra-first (R3): the pgvector and
 * redis options are mastra's **native** vector bindings (`@mastra/pg`'s
 * `PGVector` and mastra's redis vector store), injected by the host so as-graph
 * never imports an optional backend package; AGE and Graph are custom
 * {@link MastraVector} stores backed by a host driver port. Every path fails
 * closed with {@link GRAPH_MASTRA_VECTOR_UNAVAILABLE} when the bound
 * constructor/driver is absent, so no engine fabricates a store.
 *
 * Credential gate (SAA-911 F4, gate C): backend configs never carry credential
 * values. Plaintext credential members in `connection` options are refused —
 * never stripped — with {@link GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED};
 * `pgvector` requires a `credentialRef` whose `credentialId` NAMES the
 * environment variable (user-supplied `.env.secret`) carrying the password,
 * and `redis` resolves one when configured so a passwordless local instance
 * stays usable. The resolved value flows only into the binding's own options
 * and is never logged, persisted, or held by the graph layer.
 *
 * The in-memory provider ships a complete, offline-capable {@link MastraVector}
 * implementation (no external service), which is the baseline used by the RAG
 * driver tests and the config-only fallback.
 */
import { MastraVector } from "@mastra/core/vector";
import type {
  CreateIndexParams,
  DeleteIndexParams,
  DeleteVectorParams,
  DeleteVectorsParams,
  DescribeIndexParams,
  IndexStats,
  QueryResult,
  QueryVectorParams,
  UpdateVectorParams,
  UpsertVectorParams,
  VectorFilter,
} from "@mastra/core/vector";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import {
  isGraphCredentialReference,
  type GraphCredentialReference,
} from "../shared/graph/catalog/GraphCredentialReference";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  GRAPH_MASTRA_VECTOR_PROVIDER_UNKNOWN,
  GRAPH_MASTRA_VECTOR_UNAVAILABLE,
} from "./types";
import {
  assertNoMastraPlainConnectionCredentials,
  mastraCredentialEnvNameOf,
  resolveMastraCredentialValue,
} from "./MastraEnvironment";

/** The vector-store providers the RAG node can be configured with. */
export type MastraVectorProvider =
  | "memory"
  | "pgvector"
  | "redis"
  | "age"
  | "graph";

/** Every supported vector-store provider, in palette order. */
export const MASTRA_VECTOR_PROVIDERS: readonly MastraVectorProvider[] = [
  "memory",
  "pgvector",
  "redis",
  "age",
  "graph",
];

/** The similarity metrics a vector index can be created with. */
export type MastraVectorMetric = "cosine" | "euclidean" | "dotproduct";

/**
 * The vector-store configuration a `core.agent.vectorStore` node carries. It is
 * **config**, never a live store: the host resolves it through
 * {@link resolveMastraVectorStore} at execution time. Secrets are never carried
 * here as plain values — a backend that needs credentials declares a
 * `credentialRef` instead (gate C).
 */
export interface MastraVectorStoreConfig {
  /** The selected provider. */
  provider: MastraVectorProvider;
  /** Optional store id (defaults to the index name / provider). */
  id?: string;
  /** The index/collection name within the store. */
  indexName?: string;
  /** The embedding dimension the index is created with. */
  dimension?: number;
  /** The similarity metric the index is created with (defaults to `cosine`). */
  metric?: MastraVectorMetric;
  /**
   * Provider connection options. Never carries credential material (gate C,
   * SAA-911 F4): plaintext credential members are refused at resolution time.
   */
  connection?: Record<string, unknown>;
  /**
   * Credential reference resolved by document validation stage 8 (SAA-911
   * F4, gate C): `credentialId` names the environment variable that carries
   * the provider credential; the value is resolved from the host environment
   * (`.env.secret`) only at backend-construction time and is never carried by
   * the config.
   */
  credentialRef?: GraphCredentialReference;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Structural guard for {@link MastraVectorStoreConfig}: requires a known
 * provider and, when present, a well-formed credential reference.
 *
 * @param value - The candidate vector-store config.
 * @returns `true` when the value is a valid vector-store configuration.
 */
export function isMastraVectorStoreConfig(
  value: unknown
): value is MastraVectorStoreConfig {
  if (!isPlainRecord(value)) return false;
  if (
    typeof value["provider"] !== "string" ||
    !(MASTRA_VECTOR_PROVIDERS as readonly string[]).includes(value["provider"])
  ) {
    return false;
  }
  const credentialRef = value["credentialRef"];
  if (credentialRef !== undefined && !isGraphCredentialReference(credentialRef)) {
    return false;
  }
  return true;
}

/**
 * Reads the vector-store config carried by a document node. Looks at the
 * canonical `vectorStore` parameter first, then the legacy flat `provider`
 * shape; an absent or malformed value returns `undefined` so the caller fails
 * closed instead of resolving a bogus store.
 *
 * @param node - The canonical node instance.
 * @returns The validated vector-store config, or `undefined` when none is present.
 */
export function mastraVectorStoreConfigOf(
  node: GraphNodeInstance
): MastraVectorStoreConfig | undefined {
  const parameters = node.parameters ?? {};
  const candidate = parameters["vectorStore"] ?? parameters;
  return isMastraVectorStoreConfig(candidate) ? candidate : undefined;
}

/**
 * The JSON-safe, secret-free descriptor of a resolved vector store (R9): the
 * live {@link MastraVector} instance is never persisted, only this reference is.
 */
export interface MastraVectorStoreDescriptor {
  /** Stable discriminator for the resolved-reference descriptor. */
  type: "mastra.vectorStore";
  /** The selected provider. */
  provider: MastraVectorProvider;
  /** The resolved store id. */
  id: string;
  /** The configured index name. */
  indexName?: string;
  /** The configured embedding dimension. */
  dimension?: number;
  /** The configured similarity metric. */
  metric?: MastraVectorMetric;
  /** The credential reference, when one is configured (a reference, not a secret). */
  credentialRef?: GraphCredentialReference;
}

/**
 * Builds the JSON-safe descriptor for a vector-store config without resolving a
 * live store. Used by the node's `execute` projection and the step handler so no
 * non-JSON value or secret ever reaches a persisted result.
 *
 * @param config - The validated vector-store config.
 * @returns The resolved-reference descriptor.
 */
export function mastraVectorStoreDescriptorOf(
  config: MastraVectorStoreConfig
): MastraVectorStoreDescriptor {
  const descriptor: MastraVectorStoreDescriptor = {
    type: "mastra.vectorStore",
    provider: config.provider,
    id: config.id ?? config.indexName ?? config.provider,
  };
  if (config.indexName !== undefined) descriptor.indexName = config.indexName;
  if (config.dimension !== undefined) descriptor.dimension = config.dimension;
  if (config.metric !== undefined) descriptor.metric = config.metric;
  if (config.credentialRef !== undefined) {
    descriptor.credentialRef = config.credentialRef;
  }
  return descriptor;
}

/** One stored record in the in-memory store. */
interface InMemoryRecord {
  id: string;
  vector: number[];
  metadata?: Record<string, unknown>;
}

/** One in-memory index. */
interface InMemoryIndex {
  dimension: number;
  metric: MastraVectorMetric;
  records: Map<string, InMemoryRecord>;
}

/**
 * Evaluates a mastra {@link VectorFilter} against a metadata record. Supports
 * the equality shorthand plus the `$and`/`$or`/`$in`/`$ne`/`$gt`/`$gte`/`$lt`/
 * `$lte`/`$exists` operators the baseline stores need; an unrecognised operator
 * fails the match rather than silently returning the whole set.
 *
 * @param metadata - The record metadata.
 * @param filter - The mastra filter.
 * @returns `true` when the metadata satisfies the filter.
 */
function matchesFilter(
  metadata: Record<string, unknown> | undefined,
  filter: VectorFilter | undefined
): boolean {
  if (!filter) return true;
  const record = metadata ?? {};
  for (const [key, condition] of Object.entries(
    filter as Record<string, unknown>
  )) {
    if (key === "$and") {
      if (
        !Array.isArray(condition) ||
        !condition.every((entry) =>
          matchesFilter(record, entry as VectorFilter)
        )
      ) {
        return false;
      }
      continue;
    }
    if (key === "$or") {
      if (
        !Array.isArray(condition) ||
        !condition.some((entry) => matchesFilter(record, entry as VectorFilter))
      ) {
        return false;
      }
      continue;
    }
    const actual = record[key];
    if (isPlainRecord(condition)) {
      for (const [op, operand] of Object.entries(condition)) {
        switch (op) {
          case "$eq":
            if (actual !== operand) return false;
            break;
          case "$ne":
            if (actual === operand) return false;
            break;
          case "$in":
            if (!Array.isArray(operand) || !operand.includes(actual)) return false;
            break;
          case "$gt":
            if (!(typeof actual === "number" && actual > (operand as number)))
              return false;
            break;
          case "$gte":
            if (!(typeof actual === "number" && actual >= (operand as number)))
              return false;
            break;
          case "$lt":
            if (!(typeof actual === "number" && actual < (operand as number)))
              return false;
            break;
          case "$lte":
            if (!(typeof actual === "number" && actual <= (operand as number)))
              return false;
            break;
          case "$exists":
            if ((actual !== undefined) !== Boolean(operand)) return false;
            break;
          default:
            return false;
        }
      }
      continue;
    }
    if (actual !== condition) return false;
  }
  return true;
}

/** Cosine similarity between two equal-length vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Negative euclidean distance (higher is closer), keeping mastra's score ordering. */
function euclideanScore(a: number[], b: number[]): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return -Math.sqrt(sum);
}

/** Dot-product similarity between two equal-length vectors. */
function dotProduct(a: number[], b: number[]): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/** Scores two vectors under a metric (higher is always closer). */
function score(
  metric: MastraVectorMetric,
  a: number[],
  b: number[]
): number {
  switch (metric) {
    case "euclidean":
      return euclideanScore(a, b);
    case "dotproduct":
      return dotProduct(a, b);
    case "cosine":
    default:
      return cosineSimilarity(a, b);
  }
}

/**
 * The built-in **in-memory** {@link MastraVector} store (SAA-836 M4): a complete,
 * dependency-free implementation used as the RAG baseline and offline fallback.
 * It supports the full {@link MastraVector} contract, including metadata filters
 * and the cosine/euclidean/dotproduct metrics.
 */
export class InMemoryVectorStore extends MastraVector {
  /** Indexes keyed by name. */
  private readonly indexes = new Map<string, InMemoryIndex>();
  /** Monotonic id source for records upserted without an explicit id. */
  private counter = 0;

  /**
   * Creates an in-memory vector store.
   *
   * @param options - Optional store id.
   */
  constructor(options: { id?: string } = {}) {
    super({ id: options.id ?? "in-memory" });
  }

  /** Reads an index, failing closed when it does not exist. */
  private requireIndex(indexName: string): InMemoryIndex {
    const index = this.indexes.get(indexName);
    if (!index) {
      throw new GraphExecutionError(
        `In-memory vector index '${indexName}' does not exist`,
        GRAPH_MASTRA_VECTOR_UNAVAILABLE,
        { indexName }
      );
    }
    return index;
  }

  /** Creates an index with the given dimension and metric. */
  async createIndex(params: CreateIndexParams): Promise<void> {
    this.indexes.set(params.indexName, {
      dimension: params.dimension,
      metric: params.metric ?? "cosine",
      records: new Map(),
    });
  }

  /** Lists the index names. */
  async listIndexes(): Promise<string[]> {
    return [...this.indexes.keys()];
  }

  /** Describes an index (dimension, count, metric). */
  async describeIndex(params: DescribeIndexParams): Promise<IndexStats> {
    const index = this.requireIndex(params.indexName);
    const stats: IndexStats = {
      dimension: index.dimension,
      count: index.records.size,
    };
    stats.metric = index.metric;
    return stats;
  }

  /** Deletes an index. */
  async deleteIndex(params: DeleteIndexParams): Promise<void> {
    this.indexes.delete(params.indexName);
  }

  /** Upserts vectors, optionally replacing records matched by `deleteFilter`. */
  async upsert(params: UpsertVectorParams): Promise<string[]> {
    const index = this.requireIndex(params.indexName);
    if (params.deleteFilter) {
      for (const [id, record] of index.records) {
        if (matchesFilter(record.metadata, params.deleteFilter)) {
          index.records.delete(id);
        }
      }
    }
    const ids: string[] = [];
    params.vectors.forEach((vector, position) => {
      const id = params.ids?.[position] ?? `vec_${++this.counter}`;
      index.records.set(id, {
        id,
        vector,
        metadata: params.metadata?.[position],
      });
      ids.push(id);
    });
    return ids;
  }

  /** Queries an index by vector and/or metadata filter. */
  async query(params: QueryVectorParams): Promise<QueryResult[]> {
    const index = this.requireIndex(params.indexName);
    const candidates = [...index.records.values()].filter((record) =>
      matchesFilter(record.metadata, params.filter)
    );
    const scored = candidates.map((record) => {
      const scoreValue = params.queryVector
        ? score(index.metric, params.queryVector, record.vector)
        : 1;
      const result: QueryResult = {
        id: record.id,
        score: scoreValue,
        metadata: record.metadata,
      };
      if (params.includeVector) result.vector = record.vector;
      return result;
    });
    scored.sort((a, b) => b.score - a.score);
    return params.topK !== undefined ? scored.slice(0, params.topK) : scored;
  }

  /** Updates one record by id, or every record matching a filter. */
  async updateVector(params: UpdateVectorParams): Promise<void> {
    const index = this.requireIndex(params.indexName);
    if (params.id !== undefined) {
      const record = index.records.get(params.id);
      if (!record) return;
      if (params.update.vector) record.vector = params.update.vector;
      if (params.update.metadata) record.metadata = params.update.metadata;
      return;
    }
    for (const record of index.records.values()) {
      if (matchesFilter(record.metadata, params.filter)) {
        if (params.update.vector) record.vector = params.update.vector;
        if (params.update.metadata) record.metadata = params.update.metadata;
      }
    }
  }

  /** Deletes one record by id. */
  async deleteVector(params: DeleteVectorParams): Promise<void> {
    const index = this.requireIndex(params.indexName);
    index.records.delete(params.id);
  }

  /** Deletes records by explicit ids or metadata filter. */
  async deleteVectors(params: DeleteVectorsParams): Promise<void> {
    const index = this.requireIndex(params.indexName);
    if (params.ids) {
      for (const id of params.ids) index.records.delete(id);
      return;
    }
    for (const [id, record] of index.records) {
      if (matchesFilter(record.metadata, params.filter)) {
        index.records.delete(id);
      }
    }
  }
}

/**
 * Host port backing a custom {@link MastraVector} store (AGE / Graph). It mirrors
 * the {@link MastraVector} contract so the store stays a drop-in mastra vector
 * store while the actual database/graph client remains host-injected.
 */
export interface MastraVectorDriver {
  /** @see {@link MastraVector.query} */
  query(params: QueryVectorParams): Promise<QueryResult[]>;
  /** @see {@link MastraVector.upsert} */
  upsert(params: UpsertVectorParams): Promise<string[]>;
  /** @see {@link MastraVector.createIndex} */
  createIndex(params: CreateIndexParams): Promise<void>;
  /** @see {@link MastraVector.listIndexes} */
  listIndexes(): Promise<string[]>;
  /** @see {@link MastraVector.describeIndex} */
  describeIndex(params: DescribeIndexParams): Promise<IndexStats>;
  /** @see {@link MastraVector.deleteIndex} */
  deleteIndex(params: DeleteIndexParams): Promise<void>;
  /** @see {@link MastraVector.updateVector} */
  updateVector(params: UpdateVectorParams): Promise<void>;
  /** @see {@link MastraVector.deleteVector} */
  deleteVector(params: DeleteVectorParams): Promise<void>;
  /** @see {@link MastraVector.deleteVectors} */
  deleteVectors(params: DeleteVectorsParams): Promise<void>;
}

/**
 * A custom {@link MastraVector} store that delegates every contract method to a
 * host-injected {@link MastraVectorDriver}. Used for the AGE (Apache AGE) and
 * Graph (as-graph) providers, which mastra has no native binding for.
 */
export class DriverBackedVectorStore extends MastraVector {
  /**
   * Creates a driver-backed vector store.
   *
   * @param driver - The host driver implementing the store operations.
   * @param options - The store id and the provider name it represents.
   */
  constructor(
    private readonly driver: MastraVectorDriver,
    options: { id: string; provider: "age" | "graph" }
  ) {
    super({ id: options.id });
  }

  /** Delegates to the driver. */
  query(params: QueryVectorParams): Promise<QueryResult[]> {
    return this.driver.query(params);
  }

  /** Delegates to the driver. */
  upsert(params: UpsertVectorParams): Promise<string[]> {
    return this.driver.upsert(params);
  }

  /** Delegates to the driver. */
  createIndex(params: CreateIndexParams): Promise<void> {
    return this.driver.createIndex(params);
  }

  /** Delegates to the driver. */
  listIndexes(): Promise<string[]> {
    return this.driver.listIndexes();
  }

  /** Delegates to the driver. */
  describeIndex(params: DescribeIndexParams): Promise<IndexStats> {
    return this.driver.describeIndex(params);
  }

  /** Delegates to the driver. */
  deleteIndex(params: DeleteIndexParams): Promise<void> {
    return this.driver.deleteIndex(params);
  }

  /** Delegates to the driver. */
  updateVector(params: UpdateVectorParams): Promise<void> {
    return this.driver.updateVector(params);
  }

  /** Delegates to the driver. */
  deleteVector(params: DeleteVectorParams): Promise<void> {
    return this.driver.deleteVector(params);
  }

  /** Delegates to the driver. */
  deleteVectors(params: DeleteVectorsParams): Promise<void> {
    return this.driver.deleteVectors(params);
  }
}

/**
 * A mastra-native vector-store constructor the host binds for a provider
 * (`@mastra/pg`'s `PGVector` for `pgvector`, mastra's redis vector store for
 * `redis`). The store is constructed with the config's connection options and id.
 */
export type MastraVectorConstructor = new (
  options: Record<string, unknown>
) => MastraVector;

/** Host-provided mastra-native vector-store bindings, keyed by provider. */
export interface MastraVectorStoreBindings {
  /** The `@mastra/pg` `PGVector` binding, bound by the host. */
  pgvector?: MastraVectorConstructor;
  /** Mastra's native redis vector store binding, bound by the host. */
  redis?: MastraVectorConstructor;
}

/** Host-provided custom-store drivers, keyed by provider. */
export interface MastraVectorStoreDrivers {
  /** The Apache AGE driver. */
  age?: MastraVectorDriver;
  /** The as-graph (Graph) driver. */
  graph?: MastraVectorDriver;
}

/** Options {@link resolveMastraVectorStore} resolves a store with. */
export interface MastraVectorStoreResolveOptions {
  /** Mastra-native provider bindings (pgvector/redis). */
  bindings?: MastraVectorStoreBindings;
  /** Custom-provider drivers (age/graph). */
  drivers?: MastraVectorStoreDrivers;
}

/** A resolved vector store: the live {@link MastraVector} plus its JSON-safe descriptor. */
export interface ResolvedMastraVectorStore {
  /** The live store. */
  store: MastraVector;
  /** The JSON-safe, secret-free descriptor (R9). */
  descriptor: MastraVectorStoreDescriptor;
}

/**
 * Builds the constructor options a mastra-native binding is instantiated with
 * (SAA-911 F4, gate C): plaintext credential members in the connection are
 * refused — never stripped — and the credential is resolved **by name** from
 * the config's `credentialRef` at construction time (the value is read from
 * the host `.env.secret` environment and only flows into the binding's own
 * options). `pgvector` always requires a credential reference (PostgreSQL
 * authenticates every connection); `redis` resolves one when configured so a
 * passwordless local instance stays usable while a configured credential
 * still arrives through the name-only reference.
 *
 * @param config - The validated vector-store config.
 * @param provider - The provider the binding is constructed for.
 * @param id - The resolved store id.
 * @returns The constructor options, credential-resolved.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED}
 *   when the connection carries plaintext credential material.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE}
 *   when a required credential reference is absent or unresolvable.
 */
function bindingOptions(
  config: MastraVectorStoreConfig,
  provider: MastraVectorProvider,
  id: string
): Record<string, unknown> {
  const context = { provider, id, surface: "vector store" };
  const connection = { ...(config.connection ?? {}) };
  assertNoMastraPlainConnectionCredentials(connection, context);
  const options: Record<string, unknown> = {
    ...connection,
    id,
  };
  if (provider === "pgvector" || (provider === "redis" && config.credentialRef !== undefined)) {
    const credentialEnv = mastraCredentialEnvNameOf(
      config,
      context,
      `${provider} password`
    );
    options["password"] = resolveMastraCredentialValue(credentialEnv);
  }
  return options;
}

/**
 * Resolves a RAG vector-store config into a live {@link MastraVector} store.
 *
 * Mastra-first (R3): `pgvector` and `redis` use the host-bound mastra-native
 * constructors; `memory` uses the built-in {@link InMemoryVectorStore}; `age`
 * and `graph` use the host-provided {@link MastraVectorDriver}. Every path fails
 * closed with {@link GRAPH_MASTRA_VECTOR_UNAVAILABLE} when the required binding
 * or driver is absent, and an unknown provider fails with
 * {@link GRAPH_MASTRA_VECTOR_PROVIDER_UNKNOWN} — never a fabricated store.
 *
 * Credential gate (SAA-911 F4, gate C): `pgvector` requires a `credentialRef`
 * naming the environment variable that carries the password and `redis`
 * resolves one when configured — plaintext credential members in `connection`
 * options are refused in both cases, and the value is resolved from the host
 * `.env.secret` environment only at construction time.
 *
 * @param config - The validated vector-store config.
 * @param options - The host bindings and drivers.
 * @returns The live store and its JSON-safe descriptor.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED}
 *   when the connection options carry plaintext credential material.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE}
 *   when a required credential reference is absent, malformed, or its
 *   environment variable is unset or empty.
 * @throws {GraphExecutionError} when the provider binding/driver is unavailable.
 */
export function resolveMastraVectorStore(
  config: MastraVectorStoreConfig,
  options: MastraVectorStoreResolveOptions = {}
): ResolvedMastraVectorStore {
  const descriptor = mastraVectorStoreDescriptorOf(config);
  switch (config.provider) {
    case "memory":
      return {
        store: new InMemoryVectorStore({ id: descriptor.id }),
        descriptor,
      };
    case "pgvector": {
      const binding = options.bindings?.pgvector;
      if (!binding) {
        throw new GraphExecutionError(
          "The pgvector vector store requires the host-bound @mastra/pg PGVector binding",
          GRAPH_MASTRA_VECTOR_UNAVAILABLE,
          { provider: config.provider, id: descriptor.id }
        );
      }
      return {
        store: new binding(
          bindingOptions(config, "pgvector", descriptor.id)
        ),
        descriptor,
      };
    }
    case "redis": {
      const binding = options.bindings?.redis;
      if (!binding) {
        throw new GraphExecutionError(
          "The redis vector store requires the host-bound mastra redis vector store",
          GRAPH_MASTRA_VECTOR_UNAVAILABLE,
          { provider: config.provider, id: descriptor.id }
        );
      }
      return {
        store: new binding(bindingOptions(config, "redis", descriptor.id)),
        descriptor,
      };
    }
    case "age":
    case "graph": {
      const driver = options.drivers?.[config.provider];
      if (!driver) {
        throw new GraphExecutionError(
          `The ${config.provider} vector store requires a host-provided driver`,
          GRAPH_MASTRA_VECTOR_UNAVAILABLE,
          { provider: config.provider, id: descriptor.id }
        );
      }
      return {
        store: new DriverBackedVectorStore(driver, {
          id: descriptor.id,
          provider: config.provider,
        }),
        descriptor,
      };
    }
    default:
      throw new GraphExecutionError(
        `Unknown RAG vector-store provider '${String(config.provider)}'`,
        GRAPH_MASTRA_VECTOR_PROVIDER_UNKNOWN,
        { provider: String(config.provider) }
      );
  }
}
