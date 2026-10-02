/**
 * @module as-graph/tests/fixtures/workflows/engine
 * @summary Test-only engine harness for the persisted demo workflow fixtures.
 * @description Boots the real built-in catalogue + isolated-vm sandbox evaluator
 * and registers a string-schema `core.utility.code` so literal code bindings
 * validate. Every other built-in kind — including `core.utility.log` — runs
 * through the production `executorOf` registration, so the fixtures exercise the
 * real built-in executor path (resolved `request.parameters` hydration). The
 * boundary kinds (`value`/`result`) are part of the built-in registration map,
 * so they need no test-side registration. Mirrors the production wiring used by
 * the integration suite.
 */
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import {
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
  CodeNode,
} from "../../../src/node";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphNodeCatalogue } from "../../../src/engine/catalog/GraphNodeCatalogue";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { registerBuiltInGraphNodes } from "../../../src/engine/catalog/GraphBuiltInRegistrations";
import { defineGraphNode } from "../../../src/engine/catalog/GraphNodeRegistration";
import {
  bootCodeSandboxEvaluator,
  bootEngine,
  executeNode,
  freshCatalogue,
  resolveDocument,
} from "../../unit/graph/engine-fixtures";

const CODE_GRAPH_NODE_MANIFEST =
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND["core.utility.code"];

/** Boots the real engine used to execute the demo fixtures. */
export async function bootFixtureEngine(): Promise<{
  engine: GraphExecutionEngine;
  catalogue: GraphNodeCatalogue;
}> {
  const catalogue = freshCatalogue();
  const engine = await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    codeSandboxEvaluator: await bootCodeSandboxEvaluator(),
  });
  await registerBuiltInGraphNodes(catalogue);
  await catalogue.register(
    defineGraphNode({
      manifest: {
        ...CODE_GRAPH_NODE_MANIFEST,
        inputs: CODE_GRAPH_NODE_MANIFEST.inputs.map((port) =>
          port.id === "code" ? { ...port, schema: { type: "string" } } : port
        ),
      },
      executor: {
        execute: (request, context) => executeNode(CodeNode, request, context),
      },
    }),
    { replace: true }
  );
  return { engine, catalogue };
}

/** Resolves + executes a fixture through the real engine. */
export async function runFixtureDocument(
  document: GraphWorkflowDocument,
  inputs: Record<string, unknown> = {}
) {
  const { engine, catalogue } = await bootFixtureEngine();
  await resolveDocument(document, catalogue);
  return engine.execute(document, inputs);
}
