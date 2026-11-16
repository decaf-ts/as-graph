/**
 * @module as-graph/engine/runs/GraphRunDataStore
 * @summary Run metadata vs run data (n8n's `execution_entity` vs
 * `execution_data`).
 * @description The run row keeps a small summary: status, timings, the
 * workflow outputs (up to {@link graphRunSummaryOutputMaxBytes}) and each
 * node's status/duration/error. The heavy part — every node's inputs and
 * outputs, the executed document and the full outputs — is written once, as
 * compressed JSON, to a {@link GraphRunDataStore} (the blob store in
 * production: `run-data/<runId>.json.gz`), so listing runs never loads it and
 * updating a run never rewrites it. The run's request (document + inputs) is
 * stored there too at creation, so a worker in another process can execute
 * it. `GET /graph/runs/:id` reassembles the full result.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import type { BlobStoreService } from "@decaf-ts/integrations/blob";
import type { GraphWorkflowDocument } from "../../shared/graph";
import type {
  GraphExecutionResult,
  GraphExecutionValues,
  GraphNodeExecutionResult,
} from "../types";

/** What a run's data object holds. */
export interface GraphRunData {
  /** The run request, written at creation (for the executing worker). */
  request?: {
    document?: GraphWorkflowDocument;
    workflowId?: string;
    inputs: GraphExecutionValues;
    fingerprint?: string;
    /** The creating caller's principal (user, roles, namespaces, …). */
    auth?: Record<string, unknown>;
  };
  /** The full execution result (minus events, which live in the event store). */
  result?: Omit<GraphExecutionResult, "events">;
}

/** Storage of run data objects, keyed by run id. */
export interface GraphRunDataStore {
  /** Merges `data` into the run's data object. */
  save(runId: string, data: GraphRunData): Promise<void>;
  /** Reads the run's data object, or `undefined`. */
  load(runId: string): Promise<GraphRunData | undefined>;
  /** Deletes the run's data object (no-op when missing). */
  delete(runId: string): Promise<void>;
}

/** Environment variable: largest workflow output kept on the run row. */
export const GRAPH_RUN_SUMMARY_OUTPUT_MAX_ENV = "GRAPH_RUN_SUMMARY_OUTPUT_MAX_BYTES";
/** Environment variable: optional per-node value cap in run data. */
export const GRAPH_RUN_MAX_NODE_DATA_ENV = "GRAPH_RUN_MAX_NODE_DATA_BYTES";

/** The summary output ceiling (default 256 KiB). */
export function graphRunSummaryOutputMaxBytes(): number {
  const raw = Number(process.env[GRAPH_RUN_SUMMARY_OUTPUT_MAX_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : 256 * 1024;
}

/** The per-node value cap in run data, or `undefined` when off (default). */
function graphRunMaxNodeDataBytes(): number | undefined {
  const raw = Number(process.env[GRAPH_RUN_MAX_NODE_DATA_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** Size of a value's JSON form. */
function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** A value above `max` bytes is replaced by a marker. */
function capped<T>(value: T, max: number | undefined): T | { truncated: true; bytes: number } {
  if (max === undefined || value === undefined) return value;
  const bytes = jsonBytes(value);
  return bytes > max ? { truncated: true, bytes } : value;
}

/**
 * The small summary of a result stored on the run row: outputs (or a
 * truncation marker) and per-node status, timings and error — no node
 * inputs/outputs, no document, no events.
 */
export function graphRunResultSummaryOf(
  result: GraphExecutionResult
): GraphExecutionResult {
  const nodeResults: Record<string, GraphNodeExecutionResult> = {};
  for (const [id, node] of Object.entries(result.nodeResults ?? {})) {
    nodeResults[id] = {
      nodeId: node.nodeId,
      status: node.status,
      startedAt: node.startedAt,
      ...(node.finishedAt ? { finishedAt: node.finishedAt } : {}),
      ...(node.error ? { error: node.error } : {}),
      ...(node.fromCache ? { fromCache: true } : {}),
      ...(node.pinned ? { pinned: true } : {}),
    } as GraphNodeExecutionResult;
  }
  const outputs = capped(result.outputs, graphRunSummaryOutputMaxBytes());
  return {
    runId: result.runId,
    workflowId: result.workflowId,
    status: result.status,
    outputs: outputs as GraphExecutionValues,
    nodeResults,
    events: [],
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    metadata: result.metadata,
  } as unknown as GraphExecutionResult;
}

/** The data-object form of a result: everything but events, node values optionally capped. */
export function graphRunResultDataOf(
  result: GraphExecutionResult
): Omit<GraphExecutionResult, "events"> {
  const max = graphRunMaxNodeDataBytes();
  const nodeResults: Record<string, GraphNodeExecutionResult> = {};
  for (const [id, node] of Object.entries(result.nodeResults ?? {})) {
    const { events: _events, ...rest } = node;
    void _events;
    nodeResults[id] = {
      ...rest,
      inputs: capped(rest.inputs, max) as GraphExecutionValues,
      ...(rest.outputs !== undefined
        ? { outputs: capped(rest.outputs, max) as GraphExecutionValues }
        : {}),
    } as GraphNodeExecutionResult;
  }
  const { events: _events, ...rest } = result;
  void _events;
  return { ...rest, nodeResults };
}

/** Rebuilds the full result from the row summary plus the data object. */
export function graphRunResultExpanded(
  summary: GraphExecutionResult,
  data: GraphRunData | undefined
): GraphExecutionResult {
  if (!data?.result) return summary;
  return { ...summary, ...data.result, events: [] } as GraphExecutionResult;
}

/** {@link GraphRunDataStore} keeping objects in process memory (tests, embedding). */
export class InMemoryGraphRunDataStore implements GraphRunDataStore {
  // Stored as JSON text, exactly as the blob store keeps it (a structured
  // clone would carry values the run document validator rejects).
  private readonly data = new Map<string, string>();

  async save(runId: string, data: GraphRunData): Promise<void> {
    const merged = { ...((await this.load(runId)) ?? {}), ...data };
    this.data.set(runId, JSON.stringify(merged));
  }

  async load(runId: string): Promise<GraphRunData | undefined> {
    const value = this.data.get(runId);
    return value ? (JSON.parse(value) as GraphRunData) : undefined;
  }

  async delete(runId: string): Promise<void> {
    this.data.delete(runId);
  }
}

/**
 * {@link GraphRunDataStore} writing `run-data/<runId>.json.gz` to an
 * integrations blob store (the same one that keeps the run's files).
 */
export class BlobGraphRunDataStore implements GraphRunDataStore {
  constructor(private readonly blobs: BlobStoreService) {}

  private key(runId: string): string {
    return `run-data/${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.json.gz`;
  }

  async save(runId: string, data: GraphRunData): Promise<void> {
    const merged = { ...((await this.load(runId)) ?? {}), ...data };
    await this.blobs.put(this.key(runId), gzipSync(Buffer.from(JSON.stringify(merged))), {
      contentType: "application/json",
      metadata: { encoding: "gzip" },
    });
  }

  async load(runId: string): Promise<GraphRunData | undefined> {
    try {
      const result = await this.blobs.get(this.key(runId));
      const chunks: Buffer[] = [];
      for await (const chunk of result.value) chunks.push(Buffer.from(chunk));
      return JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf8")) as GraphRunData;
    } catch (error) {
      const text = `${(error as Error)?.name ?? ""} ${(error as Error)?.message ?? ""}`;
      if (/NotFound|NoSuchKey|not ?found|ENOENT/i.test(text)) return undefined;
      throw error;
    }
  }

  async delete(runId: string): Promise<void> {
    try {
      await this.blobs.delete(this.key(runId));
    } catch {
      // already gone
    }
  }
}
