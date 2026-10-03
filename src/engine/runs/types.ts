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
  release?(runId: string): void;
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
}

/** A run-creation request: an inline workflow document, or a saved `workflowId` plus optional input values. */
export interface GraphRunCreateRequest {
  /** Inline workflow document to execute. */
  workflow?: GraphWorkflowDocument;
  /** Saved workflow id to execute (requires a document resolver). */
  workflowId?: string;
  /** Input values bound to the workflow's input ports. */
  inputs?: GraphExecutionValues;
}

/** Resolves a saved workflow document by id for by-`workflowId` run requests. */
export interface GraphRunDocumentResolver {
  resolve(
    workflowId: string,
    ownerUser: string | null,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowDocument>;
}
