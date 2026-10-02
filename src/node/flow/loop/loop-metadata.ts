/**
 * @module as-graph/nodes/flow/loop/loop-metadata
 * @summary Shared loop-metadata extraction for backend loop node classes.
 * @description Reads a loop node's effective {@link GraphLoopMetadata} from the
 * canonical node instance (`parameters` plus the `loop` configuration) with the
 * execution metadata `loop` bag as the legacy fallback. Shared by the
 * `core.loop.foreach` / `core.loop.while` / `core.loop.until` node classes so
 * their `execute` methods read loop configuration identically.
 */
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import type { GraphLoopMetadata } from "../../../engine/types";
import { GraphInputError } from "../../../engine/errors/GraphInputError";

/**
 * Resolves a loop node's effective `maxIterations`, reconciling the
 * node-level configuration with the engine's run-level iteration ceiling:
 *
 * - an absent value falls back to the engine limit (itself defaulting to
 *   `fallback`), never above it;
 * - a non-numeric or non-positive value is rejected with a validation error;
 * - a positive value is floored and clamped to the engine limit.
 *
 * @param configured - The raw node `maxIterations` (untrusted).
 * @param engineLimit - The run-level engine ceiling, when exposed on the context.
 * @param fallback - The engine default ceiling used when no limit is exposed.
 * @param label - The loop kind label used in error messages.
 * @returns A bounded, positive iteration count.
 * @throws {GraphInputError} When a configured value is not a positive finite number.
 */
export function resolveLoopMaxIterations(
  configured: unknown,
  engineLimit: number | undefined,
  fallback: number,
  label: string
): number {
  const limit = engineLimit ?? fallback;
  if (configured === undefined || configured === null) {
    return Math.min(fallback, limit);
  }
  const numeric = Number(configured);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new GraphInputError(
      `${label} loop maxIterations must be a positive finite number`
    );
  }
  return Math.min(Math.floor(numeric), limit);
}

/**
 * The decorated configuration a loop node class exposes to its own `execute`
 * (DECAF-50 node rules): execution-relevant values are node properties, never
 * `@node` metadata. The loop body workflow itself remains structural and is
 * carried on the node instance's `loop.body`.
 */
export interface GraphLoopNodeConfig {
  maxIterations?: number;
  timeoutMs?: number;
  concurrency?: number;
  condition?: GraphLoopMetadata["condition"];
  inputPort?: string;
  outputPort?: string;
  itemPort?: string;
  resultPort?: string;
  statePort?: string;
  slice?: number;
}

/**
 * Extracts the loop metadata for the executing loop node.
 *
 * Reads the loop's execution-relevant configuration from the node's own decorated
 * properties (`this.*`), with the engine-injected `context.metadata.loop` bag as
 * the legacy fallback. The loop body workflow is structural and stays on the node
 * instance's `loop.body`.
 *
 * @param node - The executing loop node instance (its decorated config).
 * @param context - The run-scoped execution context for the loop node.
 * @param label - The loop kind label used in error messages.
 * @returns The effective loop metadata (body, limits, ports, condition).
 * @throws {GraphInputError} when the node carries no loop body configuration.
 */
export function extractLoopMetadata(
  node: GraphLoopNodeConfig,
  context: GraphExecutionContext,
  label: string
): GraphLoopMetadata {
  const instance = context.node;
  const loop = instance.loop;
  const fallback = (context.metadata as Record<string, unknown> | undefined)?.[
    "loop"
  ] as Record<string, unknown> | undefined;
  if (!loop?.body && !fallback?.["body"]) {
    throw new GraphInputError(
      `${label} node is missing loop configuration (instance.loop.body)`
    );
  }
  const body = (loop?.body ?? fallback?.["body"]) as GraphLoopMetadata["body"];
  const number = (key: string): number | undefined => {
    const raw =
      (node[key as keyof GraphLoopNodeConfig] as unknown) ??
      loop?.[key as "maxIterations" | "timeoutMs" | "concurrency"] ??
      fallback?.[key];
    const value = Number(raw);
    return raw !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const string = (key: string): string | undefined => {
    const raw =
      (node[key as keyof GraphLoopNodeConfig] as unknown) ??
      fallback?.[key];
    return typeof raw === "string" ? raw : undefined;
  };
  return {
    body,
    maxIterations: number("maxIterations"),
    timeoutMs: number("timeoutMs"),
    concurrency: number("concurrency"),
    condition:
      node.condition ??
      (fallback?.["condition"] as GraphLoopMetadata["condition"] | undefined),
    inputPort: string("inputPort"),
    outputPort: string("outputPort"),
    itemPort: string("itemPort"),
    resultPort: string("resultPort"),
    statePort: string("statePort"),
    slice: number("slice"),
  };
}
