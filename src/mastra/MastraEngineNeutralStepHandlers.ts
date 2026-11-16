/**
 * @module as-graph/mastra/MastraEngineNeutralStepHandlers
 * @summary Runs every engine-neutral node kind on the Mastra engine.
 * @description A workflow built for the Mastra engine is rarely agents only:
 * it fetches, filters, reshapes and stores data around them. The data, IO,
 * storage, comms, devops, trigger and utility kinds are declared once, as
 * engine-neutral `@node` classes, and this module adapts each of them to a
 * Mastra step that invokes the class's own `execute()` — through the same
 * executor, with the same request resolution (value templates, expression
 * bindings, credential references, wired configuration ports, binary
 * hydration) the general engine applies. There is no second implementation
 * and no pass-through stand-in: a kind either runs its real behaviour or is
 * not offered.
 *
 * User code (the `code` and `map` kinds, code conditions, value templates,
 * expression bindings) is evaluated host-side in the engine's
 * `CodeSandboxEvaluator` — the same isolate the general engine uses — never
 * inside the Mastra runtime. Without a configured sandbox those surfaces fail
 * closed with `GRAPH_CODE_SANDBOX_NOT_CONFIGURED`.
 *
 * `if` and `switch` run their own class too (the compiler gates the
 * downstream branches on the ports they emit). The loops and human approval
 * are translated into Mastra's own constructs and are not adapted here, and
 * `core.flow.break` is left out because a Mastra `foreach` cannot be
 * interrupted from inside its body.
 */
import { z } from "zod";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import { createStep } from "@mastra/core/workflows";
import type { GraphExecutionEngine } from "../engine/execution/GraphExecutionEngine";
import { GraphExecutionContext } from "../engine/execution/GraphExecutionContext";
import {
  applyGraphInputBindings,
  collectGraphNodeCredentials,
  resolveGraphNodeParameters,
} from "../engine/execution/GraphNodeRequestResolution";
import { graphNodeRequiresMastraEngine } from "../engine/execution/GraphNodeEngineRequirements";
import {
  dehydrateGraphBinaries,
  hydrateGraphBinaries,
} from "../engine/binary/GraphBinaryStore";
import { graphNodeStreamsBinaries } from "../engine/binary/GraphBinaryAccess";
import { builtInGraphNodeExecutor } from "../engine/catalog/GraphBuiltInRegistrations";
import type { GraphNodeExecutionRequest } from "../engine/types";
import {
  GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND,
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
} from "../node";
import type {
  GraphNodeInstance,
  GraphResolvedNodeManifest,
  GraphWorkflowDocument,
} from "../shared/graph";
import type { MastraNodeStepHandler, MastraNodeStepOptions } from "./types";

/**
 * Engine-neutral kinds the Mastra compiler translates itself, plus the kinds
 * Mastra cannot express. None of them gets an adapted step.
 */
/**
 * Engine-neutral kinds the Mastra engine cannot run at all. The backend
 * blacklists them (`unsupportedNodeKinds`), so they never appear in the Mastra
 * catalogue: `core.flow.break` interrupts a loop from inside its body, and a
 * Mastra `foreach` cannot be interrupted.
 */
export const MASTRA_UNSUPPORTED_NODE_KINDS: readonly string[] = [
  "core.flow.break",
];

export const MASTRA_ENGINE_NEUTRAL_EXCLUDED_KINDS: readonly string[] = [
  "core.loop.foreach",
  "core.loop.while",
  "core.loop.until",
  "core.flow.humanApproval",
  "core.flow.break",
];

/** Options for {@link createMastraEngineNeutralStepHandlers}. */
export interface MastraEngineNeutralStepHandlerOptions {
  /**
   * The engine facade. Nodes reach the code sandbox, the data-table store,
   * the credential resolver, the binary store and nested execution through
   * it; without it a node that needs one of those fails closed with its own
   * typed error.
   */
  engine?: GraphExecutionEngine;
}

interface StepArgs {
  inputData?: unknown;
  abortSignal?: AbortSignal;
  runId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withoutUndefined(
  outputs: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outputs)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Lists the engine-neutral kinds the Mastra engine runs through this adapter.
 *
 * @returns Every built-in engine-neutral kind except the excluded ones.
 */
export function mastraEngineNeutralKinds(): string[] {
  return Object.keys(GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND).filter(
    (kind) =>
      !graphNodeRequiresMastraEngine(kind) &&
      !MASTRA_ENGINE_NEUTRAL_EXCLUDED_KINDS.includes(kind) &&
      GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[kind] !== undefined
  );
}

/**
 * Runs one engine-neutral node instance exactly as the general engine would.
 *
 * @param node - The canonical node instance.
 * @param document - The document being executed, when known.
 * @param options - The adapter options (engine facade).
 * @param args - The Mastra step arguments (routed inputs, abort signal, run id).
 * @returns The node's outputs, binaries externalised, `undefined` members dropped.
 */
export async function runEngineNeutralNodeOnMastra(
  node: GraphNodeInstance,
  document: GraphWorkflowDocument | undefined,
  options: MastraEngineNeutralStepHandlerOptions,
  args: StepArgs
): Promise<Record<string, unknown>> {
  const engine = options.engine;
  const nodeClass = GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND[node.kind];
  const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[
    node.kind
  ] as unknown as GraphResolvedNodeManifest;
  const runId = args.runId ?? `mastra:${document?.id ?? node.id}`;
  const evaluator = engine?.codeSandboxEvaluator;
  const scope = { abortSignal: args.abortSignal };

  const routed = await applyGraphInputBindings(
    node,
    manifest,
    { ...asRecord(args.inputData) },
    evaluator,
    scope
  );
  const binaryStore = engine?.binaryStore;
  // Binaries belong to the top-level run (nested runs share its holder).
  const binaryRunId = engine?.binaryRunIdOf?.(runId) ?? runId;
  const inputs =
    binaryStore && !graphNodeStreamsBinaries(manifest)
    ? await hydrateGraphBinaries(routed, binaryStore, binaryRunId)
    : routed;
  const parameters = await resolveGraphNodeParameters(
    node,
    routed,
    evaluator,
    scope
  );
  const context = new GraphExecutionContext(
    runId,
    undefined,
    document?.id ?? node.id,
    (document ?? {
      id: node.id,
      name: node.id,
      inputs: [],
      outputs: [],
      nodes: [node],
      edges: [],
    }) as GraphWorkflowDocument,
    node,
    manifest,
    [node.id],
    async () => undefined,
    {},
    engine,
    args.abortSignal
  );
  const request: GraphNodeExecutionRequest = {
    nodeId: node.id,
    kind: node.kind,
    inputs,
    parameters,
    credentials: collectGraphNodeCredentials(node, manifest),
    metadata: node.metadata,
  };
  const outputs = withoutUndefined(
    asRecord(await builtInGraphNodeExecutor(nodeClass).execute(request, context))
  );
  return binaryStore
    ? await dehydrateGraphBinaries(outputs, binaryStore, binaryRunId)
    : outputs;
}

/**
 * Builds one Mastra step handler per engine-neutral node kind.
 *
 * @param options - The adapter options (engine facade).
 * @returns The handlers, one per kind returned by
 * {@link mastraEngineNeutralKinds}.
 */
export function createMastraEngineNeutralStepHandlers(
  options: MastraEngineNeutralStepHandlerOptions = {}
): MastraNodeStepHandler[] {
  return mastraEngineNeutralKinds().map((kind) => ({
    kind,
    createStep: (node: GraphNodeInstance, step: MastraNodeStepOptions) =>
      createStep({
        id: step.stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: StepArgs) =>
          runEngineNeutralNodeOnMastra(node, step.document, options, args),
      }),
  }));
}

/**
 * Evaluates a code-mode condition host-side for the Mastra compiler.
 *
 * @param engine - The engine facade owning the code sandbox.
 * @param condition - The code condition.
 * @param input - The value the condition reads as `$input`.
 * @param nodeId - The owning node, for error reporting.
 * @returns Whether the condition holds.
 * @throws {GraphExecutionError} `GRAPH_CODE_SANDBOX_NOT_CONFIGURED` when the
 * engine has no sandbox.
 */
export async function evaluateMastraCodeCondition(
  engine: GraphExecutionEngine | undefined,
  condition: { code: string; language?: "javascript" | "typescript" },
  input: Record<string, unknown>,
  nodeId: string
): Promise<boolean> {
  const sandbox = engine?.codeSandboxEvaluator;
  if (!sandbox) {
    throw new GraphExecutionError(
      `Code condition on node '${nodeId}' requires a CodeSandboxEvaluator to be registered in GraphExecutionEngineConfig.codeSandboxEvaluator`,
      "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
      { nodeId }
    );
  }
  return Boolean(
    await sandbox.evaluate({
      code: condition.code,
      language: condition.language,
      input,
    })
  );
}
