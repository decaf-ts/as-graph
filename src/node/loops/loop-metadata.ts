/**
 * @module as-graph/nodes/loops/loop-metadata
 * @summary Shared loop-metadata extraction for backend loop node classes.
 * @description Reads a loop node's effective {@link GraphLoopMetadata} from the
 * canonical node instance (`parameters` plus the `loop` configuration) with the
 * execution metadata `loop` bag as the legacy fallback. Shared by the
 * `core.loop.foreach` / `core.loop.while` / `core.loop.until` node classes so
 * their `execute` methods read loop configuration identically.
 */
import type { GraphExecutionContext } from "../../engine/execution/GraphExecutionContext";
import type { GraphLoopMetadata } from "../../engine/types";
import { GraphInputError } from "../../engine/errors/GraphInputError";

/**
 * Extracts the loop metadata for the executing loop node.
 *
 * @param context - The run-scoped execution context for the loop node.
 * @param label - The loop kind label used in error messages.
 * @returns The effective loop metadata (body, limits, ports, condition).
 * @throws {GraphInputError} when the node carries no loop body configuration.
 */
export function extractLoopMetadata(
  context: GraphExecutionContext,
  label: string
): GraphLoopMetadata {
  const instance = context.node;
  const parameters = (instance.parameters ?? {}) as Record<string, unknown>;
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
      parameters[key] ??
      loop?.[key as "maxIterations" | "timeoutMs" | "concurrency"] ??
      fallback?.[key];
    const value = Number(raw);
    return raw !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const string = (key: string): string | undefined => {
    const raw = parameters[key] ?? fallback?.[key];
    return typeof raw === "string" ? raw : undefined;
  };
  return {
    body,
    maxIterations: number("maxIterations"),
    timeoutMs: number("timeoutMs"),
    concurrency: number("concurrency"),
    condition: (parameters["condition"] ?? fallback?.["condition"]) as
      | GraphLoopMetadata["condition"]
      | undefined,
    inputPort: string("inputPort"),
    outputPort: string("outputPort"),
    itemPort: string("itemPort"),
    resultPort: string("resultPort"),
    statePort: string("statePort"),
    slice: number("slice"),
  };
}
