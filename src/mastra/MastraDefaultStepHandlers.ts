/**
 * @module as-graph/mastra/MastraDefaultStepHandlers
 * @summary Default Mastra step handlers for the built-in leaf node kinds
 * (SAA-807).
 * @description Provides the host-provided default handler set the Mastra
 * compiler needs to translate every built-in leaf node kind. Without it an
 * empty `stepHandlers` option makes every fixture run fail closed with
 * `GRAPH_MASTRA_UNSUPPORTED_KIND` ("Mastra backend has no step handler for
 * node kind"). Each handler builds a schema-agnostic Mastra step (`z.any()`
 * input and output schemas) that coerces the runtime's step input into a
 * record and forwards it, with special-cased behaviour for `value` (emits its
 * configured value), `core.flow.delay` (honours `timeoutMs`), and the log
 * kinds (route through the optional logger).
 */
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import type { MastraNodeStepHandler } from "./types";

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

/** Options {@link createMastraDefaultStepHandlers} is created with. */
export interface MastraDefaultStepHandlerOptions {
  /** Optional sink for the log kinds' messages (the default is silent). */
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

/** Structural subset of the Mastra runtime arguments a built-in step receives. */
type StepExecuteArgs = { inputData?: unknown };

/** The executor contract each default kind's behaviour is implemented with. */
type StepExecutor = (
  inputData: Record<string, unknown>,
  node: GraphNodeInstance
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
 * Resolves the executor implementing one default kind's behaviour. Every kind
 * forwards its (record-coerced) step input; `value` instead emits its
 * configured `value` parameter, `core.flow.delay` waits `timeoutMs`
 * milliseconds before forwarding, and the log kinds emit the node's `message`
 * parameter (falling back to its kind) through the options logger before
 * forwarding.
 *
 * @param kind - The default handler kind to build an executor for.
 * @param options - Handler-set options providing the optional logger.
 * @returns The executor the kind's Mastra steps delegate to.
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
    case "core.flow.delay":
      return async (inputData, node) => {
        const timeoutMs = asRecord(node.parameters)["timeoutMs"];
        if (typeof timeoutMs === "number" && timeoutMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        }
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
 * @param options - Optional handler-set options.
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
          return asRecord(await executor(inputData, node));
        },
      });
    },
  }));
}
