/**
 * @module as-graph/mastra/nodes/MastraNodeStepAdapter
 * @summary The single Mastra step adapter for Mastra-owned node kinds
 * (SAA-1545 §3.1).
 * @description Adapts a Mastra step's runtime input, abort signal, suspend
 * surface, and resume data to the canonical graph-node execution request,
 * instantiates the registered node class, invokes its `execute()`
 * implementation, and maps the returned values back to the Mastra output
 * shape. There is no second per-kind executor: every Mastra-owned kind reaches
 * its behaviour through this adapter and the class `execute()`.
 */
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import { graphNodeConfig } from "../../node/base";
import type { GraphNodeClass } from "../../node/base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";
import type { GraphNodeInstance } from "../../shared/graph/document/GraphNodeInstance";
import type {
  MastraNodeStepHandler,
  MastraNodeStepOptions,
} from "../types";
import type {
  MastraNodeExecutionRequest,
  MastraNodeExecutionServices,
} from "./MastraNodeExecutionServices";

/** Runtime values a Mastra step hands to its execute callback. */
export interface MastraNodeStepExecuteArgs {
  inputData?: unknown;
  abortSignal?: AbortSignal;
  suspend?: (payload?: unknown) => unknown | Promise<unknown>;
  resumeData?: unknown;
}

/**
 * Removes `undefined` object properties recursively so a node output stays
 * JSON-safe when the Mastra runtime serializes it.
 *
 * @param value - The candidate output value.
 * @returns The value with undefined object properties removed.
 */
export function sanitizeMastraNodeOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMastraNodeOutput);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== undefined) out[key] = sanitizeMastraNodeOutput(entry);
  }
  return out;
}

/**
 * Normalises a Mastra step runtime value into a plain record.
 *
 * @param value - The runtime value handed to a step's execute callback.
 * @returns The value when it is a non-array object, otherwise an empty record.
 */
export function asMastraInputRecord(
  value: unknown
): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Builds the canonical node execution request for one Mastra step invocation.
 *
 * @param node - The document node instance being executed.
 * @param options - Step options (the canonical document, when available).
 * @param services - Run-scoped host execution services.
 * @param args - The Mastra step's runtime arguments.
 * @returns The request carrying the injected runtime services.
 */
export function mastraNodeExecutionRequest(
  node: GraphNodeInstance,
  options: MastraNodeStepOptions,
  services: MastraNodeExecutionServices,
  args: MastraNodeStepExecuteArgs
): MastraNodeExecutionRequest {
  return {
    nodeId: node.id,
    kind: node.kind,
    inputs: asMastraInputRecord(args.inputData),
    parameters: { ...(node.parameters ?? {}) },
    credentials: {},
    metadata: node.metadata,
    mastra: {
      node,
      ...(options.document ? { document: options.document } : {}),
      ...(args.abortSignal ? { signal: args.abortSignal } : {}),
      services,
      ...(args.suspend ? { suspend: args.suspend } : {}),
      ...(args.resumeData !== undefined
        ? { resumeData: args.resumeData }
        : {}),
    },
  };
}

/**
 * Instantiates a registered node class and invokes its `execute()`
 * implementation for one Mastra step invocation.
 *
 * @param kind - The node kind whose class executes.
 * @param nodeClass - The registered class for the kind.
 * @param node - The document node instance.
 * @param options - Step options.
 * @param services - Run-scoped host execution services.
 * @param args - The Mastra step runtime arguments.
 * @returns The node's output values.
 */
export async function runMastraNodeClass(
  kind: string,
  nodeClass: GraphNodeClass,
  node: GraphNodeInstance,
  options: MastraNodeStepOptions,
  services: MastraNodeExecutionServices,
  args: MastraNodeStepExecuteArgs
): Promise<GraphExecutionValues> {
  const instance = nodeClass.instantiate(graphNodeConfig(node));
  const request = mastraNodeExecutionRequest(node, options, services, args);
  const result = await instance.execute(
    request as GraphNodeExecutionRequest,
    undefined as never
  );
  void kind;
  return result;
}

/**
 * Builds the Mastra step handler for one Mastra-owned node kind. The step is
 * schema-agnostic (`z.any()`), so untyped document parameters never break the
 * runtime; validation remains the node class's own responsibility.
 *
 * @param kind - The node kind to translate.
 * @param nodeClass - The registered class for the kind.
 * @param services - Run-scoped host execution services for this handler set.
 * @returns The Mastra step handler.
 */
export function createMastraNodeStepHandler(
  kind: string,
  nodeClass: GraphNodeClass,
  services: MastraNodeExecutionServices
): MastraNodeStepHandler {
  return {
    kind,
    createStep: (node: GraphNodeInstance, options: MastraNodeStepOptions) =>
      createStep({
        id: options.stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: MastraNodeStepExecuteArgs) =>
          asMastraInputRecord(
            sanitizeMastraNodeOutput(
              await runMastraNodeClass(
                kind,
                nodeClass,
                node,
                options,
                services,
                args
              )
            )
          ),
      }),
  };
}
