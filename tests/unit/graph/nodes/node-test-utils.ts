/**
 * @module as-graph/tests/unit/graph/nodes/node-test-utils
 * @summary Shared context/engine helpers for the per-node unit suites.
 * @description Every built-in node's `execute` reads the executing canonical node
 * from the {@link GraphExecutionContext} (hydrated `this.*` properties and the
 * structural `instance.loop`). These helpers build that context without booting the
 * full engine, so each per-node suite can drive the production instantiation
 * contract (`nodeClass.instantiate(graphNodeConfig(context.node))` then
 * `instance.execute(request, context)`).
 */
import type { GraphExecutionEngine } from "../../../../src/engine/execution/GraphExecutionEngine";
import type { CodeSandboxEvaluator } from "../../../../src/engine/execution/CodeSandboxEvaluator";
import { GraphExecutionContext } from "../../../../src/engine/execution/GraphExecutionContext";
import type {
  GraphExecutionEvent,
  GraphNodeInstance,
  GraphResolvedNodeManifest,
  GraphWorkflowDocument,
} from "../../../../src/shared/graph";

/** Options accepted by {@link buildNodeContext}. */
export interface NodeContextOptions {
  /** Canonical node `parameters` (the surface user configuration hydrates from). */
  parameters?: Record<string, unknown>;
  /** Canonical node `metadata` (legacy defaults merged under `parameters`). */
  nodeMetadata?: Record<string, unknown>;
  /** Free-form context metadata (loop fallback, `vars`, `$node`, logger identity). */
  contextMetadata?: Record<string, unknown>;
  /** Structural loop configuration (body workflow, limits, concurrency). */
  loop?: GraphNodeInstance["loop"];
  /** Engine facade exposed to nodes that need nested execution / the code sandbox. */
  engine?: GraphExecutionEngine;
  /** Event sink; defaults to a no-op. */
  emit?: (event: Partial<GraphExecutionEvent>) => Promise<void>;
  /** Context path from the workflow root to the node. */
  path?: string[];
}

/**
 * Builds a minimal {@link GraphExecutionContext} around a canonical node
 * instance of the given `kind`.
 */
export function buildNodeContext(
  kind: string,
  options: NodeContextOptions = {}
): GraphExecutionContext {
  const node: GraphNodeInstance = {
    id: kind,
    kind,
    parameters: (options.parameters ?? {}) as GraphNodeInstance["parameters"],
  };
  if (options.nodeMetadata) {
    node.metadata = options.nodeMetadata as GraphNodeInstance["metadata"];
  }
  if (options.loop) node.loop = options.loop;

  const document: GraphWorkflowDocument = {
    id: "wf",
    name: "wf",
    inputs: [],
    outputs: [],
    nodes: [],
    edges: [],
  };
  const manifest: GraphResolvedNodeManifest = {
    kind,
    display: { name: kind },
    inputs: [],
    outputs: [],
    parameters: [],
  };
  return new GraphExecutionContext(
    "run-1",
    undefined,
    "wf",
    document,
    node,
    manifest,
    options.path ?? [kind],
    options.emit ?? (async () => {}),
    options.contextMetadata ?? {},
    options.engine
  );
}

/**
 * Builds a fake {@link GraphExecutionEngine} whose `execute` resolves the given
 * outputs for a nested workflow call — the contract the loop node classes use.
 */
export function loopEngine(
  run: (
    inputs: Record<string, unknown>
  ) => Record<string, unknown> | Promise<Record<string, unknown>>
): GraphExecutionEngine {
  return {
    execute: async (_workflow: unknown, inputs: Record<string, unknown>) => ({
      outputs: await run(inputs),
    }),
  } as unknown as GraphExecutionEngine;
}

/**
 * Builds a fake {@link GraphExecutionEngine} whose nested `execute` throws the
 * given error — used to assert loop error propagation.
 */
export function throwingEngine(error: unknown): GraphExecutionEngine {
  return {
    execute: async () => {
      throw error;
    },
  } as unknown as GraphExecutionEngine;
}

/**
 * Builds a fake {@link GraphExecutionEngine} exposing both the nested `execute`
 * contract (for loop bodies) and a registered `codeSandboxEvaluator` (for code
 * conditions). Used by the flow-control code-mode suites.
 */
export function codeSandboxEngine(
  evaluator: CodeSandboxEvaluator,
  run: (
    inputs: Record<string, unknown>
  ) => Record<string, unknown> | Promise<Record<string, unknown>>
): GraphExecutionEngine {
  return {
    codeSandboxEvaluator: evaluator,
    execute: async (_workflow: unknown, inputs: Record<string, unknown>) => ({
      outputs: await run(inputs),
    }),
  } as unknown as GraphExecutionEngine;
}
