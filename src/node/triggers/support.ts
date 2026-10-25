/**
 * @module as-graph/nodes/triggers/support
 * @summary Shared helpers for the Stage 5b eventing trigger kinds.
 * @description The trigger kinds that consume an external stream (Redis,
 * RabbitMQ, SSE, Postgres) wait for exactly one event inside the node
 * executor: the run service starts a run, the trigger subscribes, and the run
 * continues once the first event arrives. This module owns the shared wait
 * contract — bounded timeout, run-cancellation forwarding through the
 * context's abort signal, subscription cleanup, and the JSON payload
 * projection every stream trigger applies.
 */
import type { GraphExecutionContext } from "../../engine/execution/GraphExecutionContext";
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
import { asNumber } from "../storage/support";

/** Default time a stream trigger waits for its first event before failing the node. */
export const DEFAULT_TRIGGER_TIMEOUT_MS = 30_000;

/** Resolves the configured trigger wait budget, falling back to the default. */
export function triggerTimeoutMs(value: unknown): number {
  const configured = asNumber(value);
  return configured && configured > 0
    ? Math.floor(configured)
    : DEFAULT_TRIGGER_TIMEOUT_MS;
}

/** Projects a raw stream payload: JSON-parsed when requested and parseable, the raw string otherwise. */
export function triggerPayload(raw: string, jsonParse: boolean): unknown {
  if (!jsonParse) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Normalizes an unknown runtime failure into a graph execution error for a trigger kind. */
export function triggerFailure(
  nodeName: string,
  code: string,
  error: unknown
): GraphExecutionError {
  if (error instanceof GraphExecutionError) return error;
  return new GraphExecutionError(
    `${nodeName} trigger failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    code,
    { cause: error instanceof Error ? error.name : typeof error }
  );
}

/** Runs a subscription cleanup without letting teardown failures mask the wait outcome. */
function safeCleanup(cleanup?: () => void | Promise<void>): void {
  if (!cleanup) return;
  try {
    void Promise.resolve(cleanup()).catch(() => undefined);
  } catch {
    // teardown is best-effort; the original wait outcome still wins
  }
}

/** Subscribes to a stream, reporting the first event through `emit` and failures through `fail`. */
export type TriggerSubscriber<T> = (
  emit: (value: T) => void,
  fail: (error: unknown) => void
) => Promise<() => void | Promise<void>> | (() => void | Promise<void>);

/**
 * Waits for the first event a trigger subscription reports.
 *
 * The wait is bounded by `timeoutMs` and follows the run's abort signal, so a
 * cancelled or timed-out run closes the subscription instead of leaking it.
 * The subscription's cleanup runs before this promise settles.
 *
 * @param context - The node execution context carrying the run abort signal.
 * @param timeoutMs - Maximum wait budget in milliseconds.
 * @param subscribe - Stream subscription; returns its cleanup callback.
 * @param timeoutCode - Graph error code used when the budget elapses.
 * @param timeoutMessage - Human-readable timeout message.
 * @typeParam T - The event shape the subscription reports.
 * @returns The first reported event.
 * @throws {GraphExecutionError} `GRAPH_TRIGGER_ABORTED` when the run aborts, the
 *   supplied timeout code on budget exhaustion, or the subscription failure.
 */
export async function waitForTriggerEvent<T>(
  context: GraphExecutionContext,
  timeoutMs: number,
  subscribe: TriggerSubscriber<T>,
  timeoutCode: string,
  timeoutMessage: string
): Promise<T> {
  let cleanup: (() => void | Promise<void>) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = context.abortSignal;
  let onAbort: (() => void) | undefined;

  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };

      timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new GraphExecutionError(timeoutMessage, timeoutCode, {
                timeoutMs,
              })
            )
          ),
        timeoutMs
      );

      if (signal) {
        onAbort = () =>
          settle(() =>
            reject(
              new GraphExecutionError(
                "The trigger wait was aborted because the run was cancelled or timed out",
                "GRAPH_TRIGGER_ABORTED"
              )
            )
          );
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      void Promise.resolve(
        subscribe(
          (value) => settle(() => resolve(value)),
          (error) => settle(() => reject(error))
        )
      )
        .then((registered) => {
          cleanup = registered;
          if (settled) safeCleanup(registered);
        })
        .catch((error) => settle(() => reject(error)));
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    safeCleanup(cleanup);
  }
}
