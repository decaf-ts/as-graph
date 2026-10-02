/**
 * @module as-graph/execution/GraphExecutionContext
 * @summary Decaf Context for graph node execution (DECAF-50 §4.9).
 * @description Extends Decaf's {@link Context} so node executors receive the
 * same contextual plumbing as task handlers. The context carries the
 * canonical workflow document, the executing node's canonical instance, and
 * its effective resolved manifest — never a raw node definition. Executors
 * use the context to emit progress, log messages, and report state through
 * the engine's observer pipeline. Each context also exposes a run-scoped
 * `ctx.logger` (DECAF-48 §4.3) bound to the executing node's `runId` /
 * `workflowId` / `nodeId` / `user`, so every log line streams over
 * `graph.run.log` with the DECAF-9 custom attributes.
 */
import { Context } from "@decaf-ts/core";
import type {
  GraphNodeInstance,
  GraphWorkflowDocument,
} from "../../shared/graph";
import type { Logger } from "@decaf-ts/logging";

import { GraphExecutionEventType } from "../../shared/graph";
import type { GraphResolvedNodeManifest } from "../../shared/graph";
import { GraphRunLogger } from "../../log/GraphRunLogger";
import type {
  GraphExecutionEvent,
} from "../../shared/graph";
import type {
  GraphExecutionLimits,
  GraphRunId,
} from "../types";
import type { GraphAuthData } from "../auth";
import { graphAuthDataFromRecord, graphAuthDataOf } from "../auth";
import type { GraphExecutionEngine } from "./GraphExecutionEngine";

function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
  return values.length ? values : undefined;
}

/**
 * Context passed to every graph node executor.
 *
 * The engine creates a `GraphExecutionContext` per node execution and passes
 * it to the executor alongside the node's inputs/parameters. The executor
 * uses `context.progress(...)` and `context.log(...)` to report intermediate
 * state, and `context.logger` to emit structured run log lines (DECAF-48
 * §4.3).
 */
export class GraphExecutionContext extends Context {
  private readonly runLogger?: GraphRunLogger;

  /**
   * @param runId - Unique identifier for the current execution run.
   * @param parentRunId - Run id of the parent execution (for nested loop bodies).
   * @param workflowId - The canonical workflow document id.
   * @param document - The canonical workflow document being executed.
   * @param node - The canonical node instance being executed.
   * @param manifest - The effective (dynamics-expanded) manifest for the node.
   * @param path - Dotted path from the workflow root to this node.
   * @param emitFn - Callback invoked when an event is emitted from this context.
   * @param metadata - Free-form metadata attached to this context.
   * @param engine - The owning execution engine, exposed to node classes
   *   whose `execute` needs engine-level services (nested workflow
   *   execution, code sandbox evaluation).
   * @param abortSignal - Run-level abort signal, forwarded to code sandbox
   *   evaluation so a run timeout or cancellation interrupts a pending
   *   sandbox continuation at the host boundary.
   * @param limits - Effective engine execution limits (loop iteration
   *   ceilings) for the run, read by loop node executors.
   */
  constructor(
    readonly runId: GraphRunId,
    readonly parentRunId: GraphRunId | undefined,
    readonly workflowId: string,
    readonly document: GraphWorkflowDocument,
    readonly node: GraphNodeInstance,
    readonly manifest: GraphResolvedNodeManifest,
    readonly path: string[],
    private readonly emitFn: (event: Partial<GraphExecutionEvent>) => Promise<void>,
    readonly metadata: Record<string, unknown> = {},
    readonly engine?: GraphExecutionEngine,
    readonly abortSignal?: AbortSignal,
    readonly limits?: GraphExecutionLimits
  ) {
    super();
    // Bind the resolved principal facts (already merged into the run metadata by
    // the engine) onto this context's cache, so `graphAuthDataOf(context)`
    // resolves them when this context is forwarded as the contextual arg to a
    // nested loop-body execution. Only recognized keys are copied.
    const auth = graphAuthDataFromRecord(metadata);
    // Loop nodes forward this context as the contextual argument to
    // `GraphExecutionEngine.execute`, which resolves its context through
    // `Service.context` and reads the parent context's `operation` flag. Seed it
    // with the engine's operation name or every nested body throws
    // `Key operation does not exist in accumulator`.
    this.accumulate({
      ...(auth as Record<string, unknown>),
      operation: "execute",
    });
    const user = typeof metadata?.["user"] === "string" ? metadata["user"] : null;
    this.runLogger = new GraphRunLogger({
      runId,
      workflowId,
      nodeId: node.id,
      user,
      roles: stringArrayOf(metadata?.["roles"]),
      namespaces: stringArrayOf(metadata?.["namespaces"]),
      organization:
        typeof metadata?.["organization"] === "string"
          ? (metadata["organization"] as string)
          : undefined,
      ip: typeof metadata?.["ip"] === "string" ? (metadata["ip"] as string) : undefined,
      forward: async (event) => {
        await this.emit(event);
      },
    });
  }

  /**
   * The decaf-ts {@link Logger} bound to this node's run context. Every log
   * line carries the DECAF-48 attributes (`nodeId` / `workflowId` / `runId` /
   * `user`) and is forwarded onto the existing graph execution Observable as
   * a `GRAPH_RUN_LOG` event (streamed over the `graph.run.log` SSE channel).
   */
  override get logger(): Logger {
    return this.runLogger!;
  }

  /**
   * The authenticated principal facts resolved for this run (user, roles,
   * namespaces, organization, ip). Loop node executors forward this to their
   * nested body executions so the nested nodes are authorized against the same
   * principal instead of an empty one.
   */
  get auth(): GraphAuthData {
    return graphAuthDataOf(this);
  }

  /**
   * Emits a partial graph execution event. The engine fills in runId,
   * parentRunId, workflowId, nodeId, and path automatically.
   */
  async emit(event: Partial<GraphExecutionEvent>): Promise<void> {
    await this.emitFn({
      ...event,
      runId: this.runId,
      parentRunId: this.parentRunId,
      workflowId: this.workflowId,
      nodeId: this.node.id,
      path: event.path ?? this.path,
    });
  }

  /**
   * Emits a `NODE_OUTPUT` event with the given payload, useful for reporting
   * intermediate progress from within a node executor.
   */
  async progress(payload: unknown): Promise<void> {
    await this.emit({
      type: GraphExecutionEventType.NODE_OUTPUT,
      payload,
    });
  }

  /**
   * Emits a `NODE_OUTPUT` event with a structured `{ message, payload }` shape
   * so executors can log human-readable messages.
   */
  async log(message: string, payload?: unknown): Promise<void> {
    await this.emit({
      type: GraphExecutionEventType.NODE_OUTPUT,
      payload: {
        message,
        payload,
      },
    });
  }
}
