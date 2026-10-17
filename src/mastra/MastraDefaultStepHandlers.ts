/**
 * @module as-graph/mastra/MastraDefaultStepHandlers
 * @summary Default Mastra step handlers for the built-in leaf node kinds
 * (SAA-807, hardened in SAA-824).
 * @description Provides the host-provided default handler set the Mastra
 * compiler needs to translate every built-in leaf node kind. Without it an
 * empty `stepHandlers` option makes every fixture run fail closed with
 * `GRAPH_MASTRA_UNSUPPORTED_KIND` ("Mastra backend has no step handler for
 * node kind"). Each handler builds a schema-agnostic Mastra step (`z.any()`
 * input and output schemas) that coerces the runtime's step input into a
 * record and forwards it, with special-cased behaviour for `value` (emits its
 * configured value), `core.flow.delay` (honours a *clamped* `timeoutMs` and the
 * step's `abortSignal`), the log kinds (route through the optional logger), the
 * fail-closed `core.utility.code` kind, and the degraded `core.agent` marker.
 */
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import {
  GRAPH_MASTRA_UNSUPPORTED_KIND,
  type MastraNodeStepHandler,
} from "./types";

/**
 * The built-in leaf node kinds covered by the default handler set: the
 * plain-data, flow-utility, trigger, and utility kinds that compile as opaque
 * steps. Structural kinds (`core.flow.if`/`core.flow.switch`, the
 * `core.loop.*` loops, and `core.flow.humanApproval`) are translated by the
 * compiler itself and are deliberately absent.
 */
export const MASTRA_DEFAULT_STEP_HANDLER_KINDS = [
  "value",
  "result",
  "core.agent",
  "core.flow.break",
  "core.flow.delay",
  "core.flow.errorBoundary",
  "core.flow.log",
  "core.trigger.chat",
  "core.trigger.event",
  "core.trigger.form",
  "core.trigger.manual",
  "core.trigger.schedule",
  "core.trigger.webhook",
  "core.utility.code",
  "core.utility.log",
  "core.utility.map",
] as const;

/** Any built-in leaf node kind covered by {@link MASTRA_DEFAULT_STEP_HANDLER_KINDS}. */
export type MastraDefaultStepHandlerKind =
  (typeof MASTRA_DEFAULT_STEP_HANDLER_KINDS)[number];

/**
 * Largest delay `setTimeout` accepts before Node overflows and collapses the
 * wait to ~1ms (`2^31 - 1`). {@link createMastraDefaultStepHandlers} clamps a
 * delay node's `timeoutMs` to this value *before* scheduling, so a hostile or
 * oversized declared delay can never hit the overflow degenerate path.
 */
export const MASTRA_MAX_SET_TIMEOUT_MS = 2_147_483_647;

/**
 * Default host-configurable ceiling, in milliseconds, for a `core.flow.delay`
 * node's `timeoutMs` (60s). The declared value is clamped to this ceiling, never
 * rejected, so an oversized document cannot pin a run slot for up to
 * `MASTRA_MAX_SET_TIMEOUT_MS` (~24.8 days) per node.
 */
export const DEFAULT_MASTRA_DELAY_MAX_MS = 60_000;

/**
 * Reserved key under which a default-handler result records that the node was
 * not fully executed. `core.agent` returns its forwarded input plus this key so
 * a caller can tell a declared-but-inert agent step apart from a real one; the
 * key never collides with a canonical data port.
 */
export const MASTRA_DEGRADED_OUTPUT_KEY = "__mastraDegraded";

/** Details recorded under {@link MASTRA_DEGRADED_OUTPUT_KEY}. */
export interface MastraDegradedOutput {
  /** The node kind whose declared capability was not executed. */
  kind: string;
  /** The node id the degraded result belongs to. */
  nodeId: string;
  /** Human-readable reason the node degraded to a pass-through. */
  reason: string;
}

/** Options {@link createMastraDefaultStepHandlers} is created with. */
export interface MastraDefaultStepHandlerOptions {
  /**
   * Optional sink for the log kinds' messages (the default is silent).
   *
   * The sink receives **untrusted** data: `message` is the document's
   * `node.parameters.message` verbatim and `meta` carries in-flight node data. A
   * logger implementation must treat both arguments as untrusted, JSON-serialize
   * `meta`, and never interpolate either into a line-oriented log (the pattern
   * `nest/graph/servingErrors.ts` already mandates) — otherwise a crafted
   * document enables log forging or CRLF injection.
   */
  logger?: (message: string, meta?: Record<string, unknown>) => void;
  /**
   * Host-configurable ceiling, in milliseconds, for a `core.flow.delay` node's
   * `timeoutMs`. The declared value is clamped to this ceiling (never rejected)
   * and additionally bounded by {@link MASTRA_MAX_SET_TIMEOUT_MS}; defaults to
   * {@link DEFAULT_MASTRA_DELAY_MAX_MS}.
   */
  maxDelayMs?: number;
}

/** Structural subset of the Mastra runtime arguments a built-in step receives. */
type StepExecuteArgs = { inputData?: unknown; abortSignal?: AbortSignal };

/** The executor contract each default kind's behaviour is implemented with. */
type StepExecutor = (
  inputData: Record<string, unknown>,
  node: GraphNodeInstance,
  signal?: AbortSignal
) => unknown | Promise<unknown>;

/**
 * Normalises a step runtime value into a plain record.
 *
 * @param value - The value to normalise.
 * @returns The value itself when it is a non-array object, else `{}`.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Clamps a declared `core.flow.delay` `timeoutMs` to the effective ceiling.
 *
 * A non-number, non-finite, or non-positive value yields `0` (no wait). A
 * positive value is reduced to the smaller of the configured `maxDelayMs`
 * (falling back to {@link DEFAULT_MASTRA_DELAY_MAX_MS}) and
 * {@link MASTRA_MAX_SET_TIMEOUT_MS}, so the cap is always enforced before
 * `setTimeout` is called and Node's overflow degenerate path is unreachable.
 *
 * @param requested - The untrusted `timeoutMs` value from the document.
 * @param maxDelayMs - The host-configured ceiling, when provided.
 * @returns The clamped, non-negative delay in milliseconds.
 */
function clampDelayMs(requested: unknown, maxDelayMs?: number): number {
  if (
    typeof requested !== "number" ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return 0;
  }
  const configured =
    typeof maxDelayMs === "number" && Number.isFinite(maxDelayMs) && maxDelayMs > 0
      ? maxDelayMs
      : DEFAULT_MASTRA_DELAY_MAX_MS;
  const ceiling = Math.min(configured, MASTRA_MAX_SET_TIMEOUT_MS);
  return Math.min(requested, ceiling);
}

/**
 * Sleeps for the given clamped delay, ending early when the step receives an
 * abort signal (run cancellation) so a cancelled run never leaves a detached
 * timer pinning the event loop. Forwarding is unchanged either way.
 *
 * @param delayMs - The already-clamped delay in milliseconds.
 * @param signal - The step's Mastra `abortSignal`, when the runtime supplies one.
 * @returns Resolves once the delay elapses or the signal aborts.
 */
function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (delayMs <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => finish();
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolves the executor implementing one default kind's behaviour. Every kind
 * forwards its (record-coerced) step input; `value` instead emits its
 * configured `value` parameter, `core.flow.delay` waits a clamped `timeoutMs`
 * (bounded by the options ceiling and Node's `setTimeout` maximum) before
 * forwarding, `core.agent` forwards its input with a
 * {@link MASTRA_DEGRADED_OUTPUT_KEY} marker (no agent is invoked), the log
 * kinds emit the node's `message` parameter (falling back to its kind) through
 * the options logger, and `core.utility.code` fails closed with
 * {@link GRAPH_MASTRA_UNSUPPORTED_KIND}.
 *
 * @param kind - The default handler kind to build an executor for.
 * @param options - Handler-set options providing the optional logger and delay ceiling.
 * @returns The executor the kind's Mastra steps delegate to.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_UNSUPPORTED_KIND} when a
 *   code-mode node reaches the `core.utility.code` executor.
 */
function executorFor(
  kind: MastraDefaultStepHandlerKind,
  options: MastraDefaultStepHandlerOptions
): StepExecutor {
  switch (kind) {
    case "value":
      return (_inputData, node) => ({
        value: asRecord(node.parameters)["value"] ?? null,
      });
    case "core.agent":
      return (inputData, node) => ({
        ...inputData,
        [MASTRA_DEGRADED_OUTPUT_KEY]: {
          kind: node.kind,
          nodeId: node.id,
          reason:
            "core.agent has no executor in the default handler set; the node forwarded its input without invoking an agent",
        },
      });
    case "core.utility.code":
      return (_inputData, node) => {
        throw new GraphExecutionError(
          `Mastra default step handlers do not execute code-mode node kind '${node.kind}'`,
          GRAPH_MASTRA_UNSUPPORTED_KIND,
          { nodeId: node.id, kind: node.kind }
        );
      };
    case "core.flow.delay":
      return async (inputData, node, signal) => {
        const delayMs = clampDelayMs(
          asRecord(node.parameters)["timeoutMs"],
          options.maxDelayMs
        );
        await abortableDelay(delayMs, signal);
        return inputData;
      };
    case "core.flow.log":
    case "core.utility.log":
      return (inputData, node) => {
        const message = asRecord(node.parameters)["message"];
        options.logger?.(
          typeof message === "string" ? message : node.kind,
          { nodeId: node.id, value: inputData["value"] }
        );
        return inputData;
      };
    default:
      return (inputData) => inputData;
  }
}

/**
 * Builds the default {@link MastraNodeStepHandler} set: one handler per
 * {@link MastraDefaultStepHandlerKind}. Each handler creates a
 * schema-agnostic Mastra step (`z.any()` input and output schemas) whose
 * execution coerces the runtime's input data to a record and delegates to the
 * kind's executor, so untyped document parameters never break the runtime.
 *
 * @param options - Optional handler-set options (logger and delay ceiling).
 * @returns One {@link MastraNodeStepHandler} per entry of
 *   {@link MASTRA_DEFAULT_STEP_HANDLER_KINDS}.
 */
export function createMastraDefaultStepHandlers(
  options: MastraDefaultStepHandlerOptions = {}
): MastraNodeStepHandler[] {
  return MASTRA_DEFAULT_STEP_HANDLER_KINDS.map((kind) => ({
    kind,
    createStep: (node: GraphNodeInstance, { stepId }: { stepId: string }) => {
      const executor = executorFor(kind, options);
      return createStep({
        id: stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: StepExecuteArgs) => {
          const inputData = asRecord(args.inputData);
          return asRecord(await executor(inputData, node, args.abortSignal));
        },
      });
    },
  }));
}
