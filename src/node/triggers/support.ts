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

/**
 * Resolves the payload an entry (trigger) node emits for a run.
 *
 * The engine hands a trigger the run's inputs (the body of the run request, a
 * webhook delivery, a form submission, a scheduled tick). A caller that sends
 * an explicit `payload` field gets exactly that value; otherwise the whole run
 * input record is the payload, minus the trigger's own configuration ports
 * (`schema`, `cron`, …), which are node settings and not delivered data. A run
 * started with no input at all yields `null`.
 *
 * @param inputs - The trigger's resolved inputs (the run payload plus any bound
 * configuration ports).
 * @param configurationPorts - Port ids that carry configuration, not data.
 * @returns The payload to emit on the trigger's output port.
 */
export function triggerRunPayload(
  inputs: Record<string, unknown> | undefined,
  configurationPorts: readonly string[] = []
): unknown {
  const record = inputs ?? {};
  if (Object.prototype.hasOwnProperty.call(record, "payload")) {
    return record["payload"] ?? null;
  }
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (configurationPorts.includes(key)) continue;
    payload[key] = value;
  }
  return Object.keys(payload).length > 0 ? payload : null;
}

function schemaTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function payloadProblems(
  value: unknown,
  schema: unknown,
  path: string,
  depth: number
): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  if (depth > 12) return [];
  const rules = schema as Record<string, unknown>;
  const problems: string[] = [];
  const expected = rules["type"];
  const actual = schemaTypeOf(value);
  const accepts = (type: unknown): boolean =>
    type === actual || (type === "number" && actual === "integer");
  if (typeof expected === "string" && !accepts(expected)) {
    return [`${path} must be ${expected}, got ${actual}`];
  }
  if (Array.isArray(expected) && !expected.some(accepts)) {
    return [`${path} must be one of ${expected.join(", ")}, got ${actual}`];
  }
  if (Array.isArray(rules["enum"]) && !rules["enum"].includes(value)) {
    problems.push(`${path} must be one of the allowed values`);
  }
  if (actual === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Array.isArray(rules["required"]) ? rules["required"] : []) {
      if (record[String(key)] === undefined) {
        problems.push(`${path}.${String(key)} is required`);
      }
    }
    const properties = rules["properties"];
    if (properties && typeof properties === "object") {
      for (const [key, child] of Object.entries(
        properties as Record<string, unknown>
      )) {
        if (record[key] !== undefined) {
          problems.push(
            ...payloadProblems(record[key], child, `${path}.${key}`, depth + 1)
          );
        }
      }
    }
  }
  if (actual === "array" && rules["items"]) {
    (value as unknown[]).forEach((entry, index) => {
      problems.push(
        ...payloadProblems(entry, rules["items"], `${path}[${index}]`, depth + 1)
      );
    });
  }
  return problems;
}

/**
 * Checks a delivered trigger payload against the trigger's declared schema.
 *
 * The schema is the JSON-Schema subset a trigger form produces: `type`,
 * `required`, `properties`, `items` and `enum`. A trigger without a schema, or
 * a run started with no payload at all, is not checked.
 *
 * @param nodeName - The trigger's display name, for the error message.
 * @param payload - The payload about to be emitted.
 * @param schema - The trigger's `schema` configuration.
 * @returns The payload, unchanged.
 * @throws {GraphExecutionError} `GRAPH_TRIGGER_PAYLOAD_INVALID` listing every
 * mismatch.
 */
export function assertTriggerPayload(
  nodeName: string,
  payload: unknown,
  schema: unknown
): unknown {
  if (payload === null || payload === undefined) return payload;
  const problems = payloadProblems(payload, schema, "payload", 0);
  if (problems.length > 0) {
    throw new GraphExecutionError(
      `${nodeName} trigger received a payload that does not match its schema: ${problems.join("; ")}`,
      "GRAPH_TRIGGER_PAYLOAD_INVALID",
      { problems }
    );
  }
  return payload;
}
