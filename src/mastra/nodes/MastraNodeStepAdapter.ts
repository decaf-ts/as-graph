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
import { graphNodeManifest } from "../../shared/graph";
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

const configurablePortsByClass = new WeakMap<object, readonly string[]>();

function configurablePortsOf(nodeClass: GraphNodeClass): readonly string[] {
  const key = nodeClass as unknown as object;
  let ports = configurablePortsByClass.get(key);
  if (!ports) {
    try {
      ports = graphNodeManifest(nodeClass as never)
        .inputs.filter((port) => port.configurable === true)
        .map((port) => port.id);
    } catch {
      ports = [];
    }
    configurablePortsByClass.set(key, ports);
  }
  return ports;
}

/**
 * Folds the values routed onto a node's expose-as-port inputs into its
 * parameters.
 *
 * Only ports the document actually binds (a data edge or an input binding
 * targeting the port) are considered, so a root node that receives the whole
 * run payload does not mistake a payload member for a configuration value.
 *
 * @param nodeClass - The node's class (its manifest names the ports).
 * @param node - The canonical node instance.
 * @param document - The document being executed, when known.
 * @param inputs - The inputs routed to the node.
 * @returns The node instance with wired configuration applied, or `node`
 * itself when nothing is wired.
 */
export function withWiredMastraConfiguration(
  nodeClass: GraphNodeClass,
  node: GraphNodeInstance,
  document: { edges?: readonly unknown[] } | undefined,
  inputs: Record<string, unknown>
): GraphNodeInstance {
  const bound = new Set<string>(Object.keys(node.inputBindings ?? {}));
  for (const raw of document?.edges ?? []) {
    const edge = raw as {
      type?: string;
      target?: { scope?: string; nodeId?: string; port?: string };
    };
    if (edge.type !== "data") continue;
    if (edge.target?.scope !== "node" || edge.target.nodeId !== node.id) continue;
    if (edge.target.port) bound.add(edge.target.port);
  }
  if (bound.size === 0) return node;
  const wired: Record<string, unknown> = {};
  for (const port of configurablePortsOf(nodeClass)) {
    if (bound.has(port) && inputs[port] !== undefined) wired[port] = inputs[port];
  }
  if (Object.keys(wired).length === 0) return node;
  return {
    ...node,
    parameters: { ...(node.parameters ?? {}), ...wired } as never,
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
  // A value routed onto an expose-as-port input is configuration: it reaches
  // the node (and the runtime handlers, which read `node.parameters`) exactly
  // like a value filled in the editor.
  const effective = withWiredMastraConfiguration(
    nodeClass,
    node,
    options.document,
    asMastraInputRecord(args.inputData)
  );
  const instance = nodeClass.instantiate(graphNodeConfig(effective));
  const request = mastraNodeExecutionRequest(
    effective,
    options,
    services,
    args
  );
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
