/**
 * @module as-graph/engine/runs/types
 * @summary Graph run lifecycle contracts (engine side).
 * @description Engine-scoped run contracts for the lifecycle subsystem
 * (DECAF-50 §4.14–§4.16). The frontend-safe run wire contract —
 * `GraphRunStatus`, `GraphRunEventEnvelope`, `GraphRunEventEnvelopeInput`
 * and the run limits/terminal predicates — lives in
 * `@decaf-ts/as-graph/shared` (imported from there).
 *
 * Engine-only contracts: the full {@link GraphRun} shape (whose `result?`
 * carries engine dates) and the run store/event-store/create-request/
 * document-resolver ports.
 */
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import type { GraphWorkflowDocument } from "../../shared/graph";
import type { GraphRunModel } from "../../shared/graph";
import type { GraphExecutionResult, GraphExecutionValues } from "../types";
import type { GraphExecutionErrorPayload } from "../../shared/graph";
import type {
  GraphRunEventEnvelope,
  GraphRunStatus,
} from "../../shared/graph";

/**
 * Engine-side run record (DECAF-50 §4.14): lifecycle status, timestamps, and
 * — once terminal — the execution result, error payload, and the fingerprint
 * of the document the run executed.
 */
export interface GraphRun {
  /** Unique run id. */
  runId: string;
  /** Workflow (document) id the run executes. */
  workflowId: string;
  /** Owning user; `null` for anonymous callers. */
  ownerUser: string | null;
  /** Current lifecycle status. */
  status: GraphRunStatus;
  /** ISO timestamp when the run was created. */
  createdAt: string;
  /** ISO timestamp when execution started, once it has. */
  startedAt?: string;
  /** ISO timestamp when the run reached a terminal state. */
  finishedAt?: string;
  /** Execution result, present on successful completion. */
  result?: GraphExecutionResult;
  /** Structured error payload, present on failure. */
  error?: GraphExecutionErrorPayload;
  /** Fingerprint of the executed document (stable SHA-256). */
  documentFingerprint?: string;
  /** Worker process executing the run. */
  workerId?: string;
  /** ISO timestamp of the executing worker's last liveness beat. */
  heartbeatAt?: string;
  /** ISO timestamp set while the run waits for external input. */
  suspendedAt?: string;
  /** Execution attempts so far. */
  attempt?: number;
  /** Concurrency/quota bucket of the caller. */
  callerKey?: string;
  /** Caller-scoped idempotency key of the create request. */
  idempotencyKey?: string;
  /** SHA-256 of the create request. */
  requestHash?: string;
  /** Bytes the run's files and run data occupy. */
  storedBytes?: number;
}

/**
 * Persistence port for run records: durable implementations save/read runs
 * with an optional leading Decaf {@link Context}.
 */
export interface GraphRunEventStore {
  /** Appends a sequenced event envelope and notifies live subscribers. */
  append(event: GraphRunEventEnvelope): Promise<void>;
  /** Returns the run's envelopes with `sequence` greater than the given one (SSE replay). */
  listAfter(runId: string, sequence: number): Promise<GraphRunEventEnvelope[]>;
  /**
   * Subscribes a live listener to the run's stream; returns an unsubscribe function.
   */
  subscribe(
    runId: string,
    listener: (event: GraphRunEventEnvelope) => void
  ): () => void;
  /**
   * Releases all retained event state for a finished run (after the replay
   * window). Optional: in-memory stores implement it; durable stores may
   * no-op or keep events for audit.
   */
  release?(runId: string): void | Promise<void>;
  /** The highest stored sequence of a run (`0` when none). */
  lastSequence?(runId: string): Promise<number>;
}

/** Persistence port for run records: save, read by id, and list by workflow, with optional leading {@link Context}. */
export interface GraphRunStore {
  saveRun(
    run: GraphRun,
    ...args: MaybeContextualArg<Context>
  ): Promise<void>;
  readRun(
    runId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun | null>;
  /**
   * Lists every persisted run row that executed the given workflow document.
   *
   * Rows are returned as their persisted {@link GraphRunModel} shape so the
   * serving list keeps the storage-derived fields (`updatedAt`, `inputs`) that
   * the engine {@link GraphRun} does not carry. Implementations are free to
   * return the rows in any order; the run service orders the serving result.
   * An unknown workflow yields an empty list.
   */
  listRuns(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRunModel[]>;
  /**
   * One batch of finished (succeeded, failed or cancelled) runs retention may
   * prune: those finished before `before` (oldest first), or — with
   * `keepNewest` — those beyond the newest `keepNewest` finished runs. Indexed
   * on `(status, finishedAt)`; stores that do not implement it are never
   * pruned.
   */
  listPrunableRuns?(
    query: GraphRunPruneQuery,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRunRetentionEntry[]>;
  /**
   * Runs not finished, not suspended, whose worker stopped beating (or that
   * never started) before `before` — candidates for orphan recovery.
   */
  listStaleRuns?(
    query: { before: Date; includeQueued: boolean },
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun[]>;
  /** Records a liveness beat of the worker executing a run. */
  heartbeat?(
    runId: string,
    workerId: string,
    at: Date,
    ...args: MaybeContextualArg<Context>
  ): Promise<void>;
  /** Unfinished runs of a caller bucket (concurrency and quota checks). */
  countActiveRuns?(
    callerKey: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<number>;
  /** Runs a caller bucket created since an instant (rate quota). */
  countRunsSince?(
    callerKey: string,
    since: Date,
    ...args: MaybeContextualArg<Context>
  ): Promise<number>;
  /** The run created with a caller-scoped idempotency key, if any. */
  findByIdempotencyKey?(
    idempotencyKey: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphRun | null>;
  /** Total `storedBytes` of a caller bucket's runs (storage quota). */
  sumStoredBytes?(
    callerKey: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<number>;
  /** Deletes a run row; deleting an unknown run is a no-op. */
  deleteRun?(
    runId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<void>;
}

/** One retention query: exactly one of `before` / `keepNewest`, plus a batch size. */
export interface GraphRunPruneQuery {
  /** Finished strictly before this instant. */
  before?: Date;
  /** Skip the newest N finished runs; return the next ones. */
  keepNewest?: number;
  /** Batch size. */
  limit: number;
}

/** Run statuses of a run that has not finished. */
export const GRAPH_RUN_ACTIVE_STATUSES = ["queued", "validating", "running"] as const;

/** Run statuses retention may prune. */
export const GRAPH_RUN_FINISHED_STATUSES = ["succeeded", "failed", "cancelled"] as const;

/** What run retention reads about a finished run. */
export interface GraphRunRetentionEntry {
  runId: string;
  status: string;
  createdAt?: Date;
  finishedAt?: Date;
}

/**
 * Run retention (n8n's execution pruning): finished runs older than
 * `maxAgeMs`, and those beyond the newest `maxCount`, are deleted with their
 * events and the files only they hold. Runs still queued or running are never
 * pruned; a file a pinned value holds survives its runs.
 */
export interface GraphRunRetentionOptions {
  /** Maximum age of a finished run, from its finish time. Unset: no age limit. */
  maxAgeMs?: number;
  /** Maximum number of finished runs kept (newest first). Unset: no count limit. */
  maxCount?: number;
  /**
   * How often the periodic prune runs; a prune also follows every finished
   * run. Default one hour; `0` disables the timer.
   */
  intervalMs?: number;
  /**
   * How often expired pinned values are swept (and their files released).
   * Default one hour; `0` disables the sweep.
   */
  pinSweepIntervalMs?: number;
}

/** A run-creation request: an inline workflow document, or a saved `workflowId` plus optional input values. */
export interface GraphRunCreateRequest {
  /** Inline workflow document to execute. */
  workflow?: GraphWorkflowDocument;
  /** Saved workflow id to execute (requires a document resolver). */
  workflowId?: string;
  /** Input values bound to the workflow's input ports. */
  inputs?: GraphExecutionValues;
  /**
   * Idempotency key (`Idempotency-Key` header): a repeat with the same key
   * and request within 24 h returns the original run.
   */
  idempotencyKey?: string;
}

/** Resolves a saved workflow document by id for by-`workflowId` run requests. */
export interface GraphRunDocumentResolver {
  resolve(
    workflowId: string,
    ownerUser: string | null,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowDocument>;
}
