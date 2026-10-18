/**
 * @module as-graph/execution/GraphWebhookResponseRegistry
 * @summary Run-keyed webhook response correlation for the engine.
 * @description Registry the engine owns (`webhookResponses`) that correlates a
 * webhook trigger's wait with the `core.io.respondToWebhook` node's delivery.
 * A webhook-triggered run registers a pending wait keyed by its `runId`; when
 * the Respond to Webhook node finishes it delivers the response against the
 * same `runId`, resolving the waiter. Pending waits can carry a timeout that
 * rejects with `GRAPH_WEBHOOK_RESPONSE_TIMEOUT` when no response arrives in
 * time; timers are unref'd so they never hold the process open. Re-registering
 * a `runId` cancels the previous wait first — one run has at most one waiter.
 */
import { GraphExecutionError } from "../errors/GraphExecutionError";

/**
 * The HTTP response a Respond to Webhook node produced for a run.
 */
export interface GraphWebhookResponse {
  /** HTTP status code the node resolved (default 200). */
  statusCode: number;
  /** Response headers; non-string entries were filtered out. */
  headers: Record<string, string>;
  /** The resolved response body. */
  body: unknown;
  /** The run id the response belongs to — the correlation key. */
  runId: string;
  /** ISO-8601 timestamp of when the node built the response. */
  respondedAt: string;
}

/**
 * A registered waiter plus its optional timeout timer.
 */
interface PendingGraphWebhookResponse {
  resolve: (response: GraphWebhookResponse) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Run-keyed registry of pending webhook responses.
 */
export class GraphWebhookResponseRegistry {
  /** Pending waits keyed by run id; at most one waiter per run. */
  private readonly pending = new Map<string, PendingGraphWebhookResponse>();

  /**
   * Registers a pending wait for a run's webhook response.
   *
   * Any previous wait for the same `runId` is cancelled first (its timer
   * cleared, its promise never resolved). With a positive finite
   * `timeoutMs` the wait rejects with `GRAPH_WEBHOOK_RESPONSE_TIMEOUT` after
   * that period; the timer is unref'd so it never keeps the process alive.
   *
   * @param runId - The run id to wait on.
   * @param timeoutMs - Optional timeout in milliseconds.
   * @returns The promise resolved by {@linkcode GraphWebhookResponseRegistry.deliver}.
   */
  register(
    runId: string,
    timeoutMs?: number
  ): Promise<GraphWebhookResponse> {
    this.cancel(runId);
    return new Promise<GraphWebhookResponse>((resolve, reject) => {
      const entry: PendingGraphWebhookResponse = { resolve };
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(runId);
          reject(
            new GraphExecutionError(
              `No webhook response was produced for run '${runId}' within ${timeoutMs}ms`,
              "GRAPH_WEBHOOK_RESPONSE_TIMEOUT",
              { runId, timeoutMs }
            )
          );
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(runId, entry);
    });
  }

  /**
   * Checks whether a run has a pending wait.
   *
   * @param runId - The run id to check.
   * @returns `true` when a wait is registered for the run.
   */
  has(runId: string): boolean {
    return this.pending.has(runId);
  }

  /**
   * Delivers a response to the run's pending wait.
   *
   * Clears the wait (and its timer) before resolving, so the waiter can
   * re-register immediately without racing the old entry.
   *
   * @param runId - The run id the response belongs to.
   * @param response - The response to hand to the waiter.
   * @returns `true` when a waiter received the response, `false` when no wait
   *   was registered for the run.
   */
  deliver(runId: string, response: GraphWebhookResponse): boolean {
    const entry = this.pending.get(runId);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(runId);
    entry.resolve(response);
    return true;
  }

  /**
   * Cancels a run's pending wait without resolving it.
   *
   * The waiter's promise is never settled; the timeout timer, if any, is
   * cleared so it cannot reject either. No-op when no wait is registered.
   *
   * @param runId - The run id whose wait to cancel.
   */
  cancel(runId: string): void {
    const entry = this.pending.get(runId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(runId);
  }

  /**
   * Cancels every pending wait.
   */
  clear(): void {
    for (const runId of [...this.pending.keys()]) {
      this.cancel(runId);
    }
  }
}
