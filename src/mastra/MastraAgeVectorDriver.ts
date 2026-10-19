/**
 * @module as-graph/mastra/MastraAgeVectorDriver
 * @summary Apache AGE vector-store driver for the custom mastra `age` provider
 * (SAA-749 Stage 4).
 * @description Mastra has no stock Apache AGE binding, so the `age` vector
 * store is a custom {@link MastraVector} implementation (see
 * {@link DriverBackedVectorStore}). This module supplies the reference driver:
 * it keeps one similarity index per mastra index name in tables inside the
 * AGE-created graph schema and computes cosine/euclidean/dot-product scores
 * in-process, so it works on any AGE-enabled PostgreSQL database without the
 * pgvector extension. The database connection stays host-owned through the
 * minimal {@link MastraVectorSqlClient} port — as-graph never imports a
 * Postgres client (the optional `pg` dependency is the host's choice).
 *
 * The driver registers the AGE graph on first use and fails closed with
 * {@link GRAPH_MASTRA_VECTOR_UNAVAILABLE} when the extension or graph cannot be
 * created, so a misconfigured `age` provider never silently degrades to another
 * backend. SQL identifiers are validated and quoted; every value is bound as a
 * query parameter (metadata is stored as `jsonb`).
 */
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
} from "@mastra/core/vector";
import { randomUUID } from "node:crypto";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import { GRAPH_MASTRA_VECTOR_UNAVAILABLE } from "./types";
import {
  mastraVectorMatchesFilter,
  mastraVectorScore,
  type MastraVectorDriver,
  type MastraVectorMetric,
} from "./MastraVectorStore";

/** One row returned by a {@link MastraVectorSqlClient} query. */
export type MastraVectorSqlRow = Record<string, unknown>;

/** Result of one SQL statement. */
export interface MastraVectorSqlResult {
  /** The returned rows (empty for statements that return no rows). */
  rows: MastraVectorSqlRow[];
}

/**
 * Minimal SQL port the AGE driver runs against. A host backs it with `pg`'s
 * `Pool`/`Client` (or any other PostgreSQL driver) and owns the connection
 * lifecycle and credentials; as-graph never imports the client package.
 */
export interface MastraVectorSqlClient {
  /**
   * Runs one parameterized statement.
   *
   * @param sql - The SQL text with `$1`-style placeholders.
   * @param params - The bound parameter values, in placeholder order.
   * @returns The statement's rows.
   */
  query(
    sql: string,
    params?: readonly unknown[]
  ): Promise<MastraVectorSqlResult>;
}

/** Options a {@link createMastraAgeVectorDriver} driver is built with. */
export interface MastraAgeVectorDriverOptions {
  /** The host-owned SQL client connected to the AGE-enabled database. */
  client: MastraVectorSqlClient;
  /**
   * The AGE graph name; the driver creates it on first use and stores its
   * tables in the graph's schema. Must be a plain SQL identifier.
   * Defaults to `as_graph_age_vectors`.
   */
  graphName?: string;
  /**
   * Table-name prefix inside the graph schema (the driver appends `_indexes`
   * and `_vectors`). Must be a plain SQL identifier. Defaults to `vectors`.
   */
  tablePrefix?: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates a SQL identifier supplied through config, refusing anything that
 * could escape the quoted identifier.
 *
 * @param value - The identifier to validate.
 * @param label - The option name (error details).
 * @returns The validated identifier.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_VECTOR_UNAVAILABLE} when the
 *   identifier is empty or contains unsupported characters.
 */
function identifierOf(value: string, label: string): string {
  if (value.length > 63 || !IDENTIFIER.test(value)) {
    throw new GraphExecutionError(
      `The Apache AGE vector store ${label} '${value}' is not a valid SQL identifier (letters, digits, and underscores; at most 63 characters)`,
      GRAPH_MASTRA_VECTOR_UNAVAILABLE,
      { option: label, value }
    );
  }
  return value;
}

/**
 * Coerces a database vector representation into a number array. PostgreSQL
 * drivers differ on whether `double precision[]` arrives as an array or as the
 * text form `{1,2,3}`.
 *
 * @param value - The raw column value.
 * @returns The parsed vector.
 * @throws {GraphExecutionError} when the value is not a numeric array.
 */
function vectorOf(value: unknown): number[] {
  if (Array.isArray(value)) {
    const vector = value.map((entry) => Number(entry));
    if (vector.every((entry) => Number.isFinite(entry))) return vector;
  }
  if (typeof value === "string") {
    const text = value.trim().replace(/^\{/, "").replace(/\}$/, "");
    if (text.length === 0) return [];
    const vector = text.split(",").map((entry) => Number(entry.trim()));
    if (vector.every((entry) => Number.isFinite(entry))) return vector;
  }
  throw new GraphExecutionError(
    "The Apache AGE vector store read a vector column that is not a numeric array",
    GRAPH_MASTRA_VECTOR_UNAVAILABLE
  );
}

/**
 * Coerces a database metadata representation into a plain object.
 *
 * @param value - The raw `jsonb` column value.
 * @returns The metadata, or `undefined` when unset.
 * @throws {GraphExecutionError} when the value is neither an object nor valid
 *   JSON object text.
 */
function metadataOf(
  value: unknown
): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      throw new GraphExecutionError(
        `The Apache AGE vector store read unparseable metadata JSON: ${String(error)}`,
        GRAPH_MASTRA_VECTOR_UNAVAILABLE
      );
    }
  }
  throw new GraphExecutionError(
    "The Apache AGE vector store read a metadata column that is not a JSON object",
    GRAPH_MASTRA_VECTOR_UNAVAILABLE
  );
}

/** The metric a stored index declares, defaulting to cosine. */
function metricOf(value: unknown): MastraVectorMetric {
  return value === "euclidean" || value === "dotproduct" ? value : "cosine";
}

/**
 * Creates the reference Apache AGE driver for the custom mastra `age` vector
 * store.
 *
 * The returned driver implements mastra's {@link MastraVectorDriver} contract;
 * wrap it with {@link DriverBackedVectorStore} (the `age` provider resolution
 * does this automatically) or pass it as `vectorStoreDrivers.age`. It keeps
 * vectors in the AGE graph schema and scores them in-process, so the AGE
 * extension and its graph are the only database prerequisites.
 *
 * @param options - The SQL client and optional graph/table identifiers.
 * @returns A driver over the AGE-enabled database.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_VECTOR_UNAVAILABLE} when a
 *   configured identifier is invalid.
 */
export function createMastraAgeVectorDriver(
  options: MastraAgeVectorDriverOptions
): MastraVectorDriver {
  const graph = identifierOf(
    options.graphName ?? "as_graph_age_vectors",
    "graphName"
  );
  const prefix = identifierOf(options.tablePrefix ?? "vectors", "tablePrefix");
  const client = options.client;
  const schema = `"${graph}"`;
  const indexesTable = `${schema}."${prefix}_indexes"`;
  const vectorsTable = `${schema}."${prefix}_vectors"`;

  let graphReady: Promise<void> | undefined;

  const ensureGraph = (): Promise<void> => {
    if (!graphReady) {
      graphReady = (async () => {
        const extension = await client.query(
          "SELECT extname FROM pg_extension WHERE extname = 'age'"
        );
        if (extension.rows.length === 0) {
          throw new GraphExecutionError(
            "The Apache AGE vector store requires the 'age' extension on the target database",
            GRAPH_MASTRA_VECTOR_UNAVAILABLE,
            { graph }
          );
        }
        const existing = await client.query(
          "SELECT name FROM ag_catalog.ag_graph WHERE name = $1",
          [graph]
        );
        if (existing.rows.length === 0) {
          await client.query("SELECT ag_catalog.create_graph($1::name)", [graph]);
        }
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${indexesTable} (
            index_name text PRIMARY KEY,
            dimension integer NOT NULL,
            metric text NOT NULL
          )`
        );
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${vectorsTable} (
            index_name text NOT NULL REFERENCES ${indexesTable}(index_name) ON DELETE CASCADE,
            id text NOT NULL,
            vector double precision[] NOT NULL,
            metadata jsonb,
            PRIMARY KEY (index_name, id)
          )`
        );
      })().catch((error: unknown) => {
        graphReady = undefined;
        if (error instanceof GraphExecutionError) throw error;
        throw new GraphExecutionError(
          `The Apache AGE vector store could not initialize graph '${graph}': ${String(error)}`,
          GRAPH_MASTRA_VECTOR_UNAVAILABLE,
          { graph }
        );
      });
    }
    return graphReady;
  };

  const requireIndex = async (
    indexName: string
  ): Promise<{ dimension: number; metric: MastraVectorMetric }> => {
    const result = await client.query(
      `SELECT dimension, metric FROM ${indexesTable} WHERE index_name = $1`,
      [indexName]
    );
    const row = result.rows[0];
    if (!row) {
      throw new GraphExecutionError(
        `Apache AGE vector index '${indexName}' does not exist in graph '${graph}'`,
        GRAPH_MASTRA_VECTOR_UNAVAILABLE,
        { graph, indexName }
      );
    }
    const dimension = Number(row["dimension"]);
    if (!Number.isFinite(dimension)) {
      throw new GraphExecutionError(
        `Apache AGE vector index '${indexName}' has an invalid dimension`,
        GRAPH_MASTRA_VECTOR_UNAVAILABLE,
        { graph, indexName }
      );
    }
    return { dimension, metric: metricOf(row["metric"]) };
  };

  const rowsOf = async (
    indexName: string
  ): Promise<
    Array<{
      id: string;
      vector: number[];
      metadata?: Record<string, unknown>;
    }>
  > => {
    const result = await client.query(
      `SELECT id, vector, metadata FROM ${vectorsTable} WHERE index_name = $1`,
      [indexName]
    );
    return result.rows.map((row) => ({
      id: String(row["id"]),
      vector: vectorOf(row["vector"]),
      metadata: metadataOf(row["metadata"]),
    }));
  };

  return {
    async createIndex(params: CreateIndexParams): Promise<void> {
      await ensureGraph();
      await client.query(
        `INSERT INTO ${indexesTable} (index_name, dimension, metric)
         VALUES ($1, $2, $3)
         ON CONFLICT (index_name)
         DO UPDATE SET dimension = EXCLUDED.dimension, metric = EXCLUDED.metric`,
        [
          params.indexName,
          params.dimension,
          params.metric ?? "cosine",
        ]
      );
    },

    async listIndexes(): Promise<string[]> {
      await ensureGraph();
      const result = await client.query(
        `SELECT index_name FROM ${indexesTable} ORDER BY index_name`
      );
      return result.rows.map((row) => String(row["index_name"]));
    },

    async describeIndex(params: DescribeIndexParams): Promise<IndexStats> {
      await ensureGraph();
      const index = await requireIndex(params.indexName);
      const count = await client.query(
        `SELECT COUNT(*)::integer AS count FROM ${vectorsTable} WHERE index_name = $1`,
        [params.indexName]
      );
      return {
        dimension: index.dimension,
        count: Number(count.rows[0]?.["count"] ?? 0),
        metric: index.metric,
      };
    },

    async deleteIndex(params: DeleteIndexParams): Promise<void> {
      await ensureGraph();
      await client.query(
        `DELETE FROM ${indexesTable} WHERE index_name = $1`,
        [params.indexName]
      );
    },

    async upsert(params: UpsertVectorParams): Promise<string[]> {
      await ensureGraph();
      await requireIndex(params.indexName);
      if (params.deleteFilter) {
        const existing = await rowsOf(params.indexName);
        const ids = existing
          .filter((entry) =>
            mastraVectorMatchesFilter(entry.metadata, params.deleteFilter)
          )
          .map((entry) => entry.id);
        if (ids.length > 0) {
          await client.query(
            `DELETE FROM ${vectorsTable} WHERE index_name = $1 AND id = ANY($2::text[])`,
            [params.indexName, ids]
          );
        }
      }
      const ids: string[] = [];
      for (const [position, vector] of params.vectors.entries()) {
        const id =
          params.ids?.[position] ?? `${randomUUID()}_${position}`;
        await client.query(
          `INSERT INTO ${vectorsTable} (index_name, id, vector, metadata)
           VALUES ($1, $2, $3::double precision[], $4::jsonb)
           ON CONFLICT (index_name, id)
           DO UPDATE SET vector = EXCLUDED.vector, metadata = EXCLUDED.metadata`,
          [
            params.indexName,
            id,
            vector,
            params.metadata?.[position] === undefined
              ? null
              : JSON.stringify(params.metadata[position]),
          ]
        );
        ids.push(id);
      }
      return ids;
    },

    async query(params: QueryVectorParams): Promise<QueryResult[]> {
      await ensureGraph();
      const index = await requireIndex(params.indexName);
      const rows = await rowsOf(params.indexName);
      const scored = rows
        .filter((entry) =>
          mastraVectorMatchesFilter(entry.metadata, params.filter)
        )
        .map((entry) => {
          const result: QueryResult = {
            id: entry.id,
            score: params.queryVector
              ? mastraVectorScore(index.metric, params.queryVector, entry.vector)
              : 1,
            metadata: entry.metadata,
          };
          if (params.includeVector) result.vector = entry.vector;
          return result;
        });
      scored.sort((a, b) => b.score - a.score);
      return params.topK !== undefined ? scored.slice(0, params.topK) : scored;
    },

    async updateVector(params: UpdateVectorParams): Promise<void> {
      await ensureGraph();
      await requireIndex(params.indexName);
      if (params.id !== undefined) {
        await client.query(
          `UPDATE ${vectorsTable}
           SET vector = COALESCE($3::double precision[], vector),
               metadata = COALESCE($4::jsonb, metadata)
           WHERE index_name = $1 AND id = $2`,
          [
            params.indexName,
            params.id,
            params.update.vector ?? null,
            params.update.metadata === undefined
              ? null
              : JSON.stringify(params.update.metadata),
          ]
        );
        return;
      }
      const rows = await rowsOf(params.indexName);
      const ids = rows
        .filter((entry) =>
          mastraVectorMatchesFilter(entry.metadata, params.filter)
        )
        .map((entry) => entry.id);
      for (const id of ids) {
        await client.query(
          `UPDATE ${vectorsTable}
           SET vector = COALESCE($3::double precision[], vector),
               metadata = COALESCE($4::jsonb, metadata)
           WHERE index_name = $1 AND id = $2`,
          [
            params.indexName,
            id,
            params.update.vector ?? null,
            params.update.metadata === undefined
              ? null
              : JSON.stringify(params.update.metadata),
          ]
        );
      }
    },

    async deleteVector(params: DeleteVectorParams): Promise<void> {
      await ensureGraph();
      await requireIndex(params.indexName);
      await client.query(
        `DELETE FROM ${vectorsTable} WHERE index_name = $1 AND id = $2`,
        [params.indexName, params.id]
      );
    },

    async deleteVectors(params: DeleteVectorsParams): Promise<void> {
      await ensureGraph();
      await requireIndex(params.indexName);
      if (params.ids) {
        if (params.ids.length === 0) return;
        await client.query(
          `DELETE FROM ${vectorsTable} WHERE index_name = $1 AND id = ANY($2::text[])`,
          [params.indexName, params.ids]
        );
        return;
      }
      const rows = await rowsOf(params.indexName);
      const ids = rows
        .filter((entry) =>
          mastraVectorMatchesFilter(entry.metadata, params.filter)
        )
        .map((entry) => entry.id);
      if (ids.length === 0) return;
      await client.query(
        `DELETE FROM ${vectorsTable} WHERE index_name = $1 AND id = ANY($2::text[])`,
        [params.indexName, ids]
      );
    },
  };
}
