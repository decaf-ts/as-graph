/**
 * @module as-graph/tests/unit/graph/NestedLoopAuthPropagation.test
 * @summary Unit tests for nested-loop auth propagation (SAA-2079 M3).
 * @description Proves loop node bodies are executed against the parent run's
 * authenticated principal: the nested `engine.execute` options carry the parent
 * `auth`, the parent `GraphExecutionContext` is forwarded as the contextual
 * argument, and — with `authEnabled` — a body workflow is authorized (or fails
 * closed) against the real principal rather than an empty one.
 */
import { ForbiddenError } from "@decaf-ts/core";
import { GraphForeachLoopNode, GraphWhileLoopNode } from "../../../src/node";
import { graphAuthDataOf } from "../../../src/engine/auth/GraphAuth";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { defineGraphNode } from "../../../src/engine/catalog/GraphNodeRegistration";
import type { GraphLoopMetadata } from "../../../src/engine/types";
import type {
  GraphNodeInstance,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import type { GraphResolvedNodeManifest } from "../../../src/shared/graph";
import type { GraphExecutionContext } from "../../../src/engine/execution/GraphExecutionContext";
import { GraphExecutionContext as GraphExecutionContextClass } from "../../../src/engine/execution/GraphExecutionContext";
import {
  bootEngine,
  documentEdge,
  documentNode,
  documentPort,
  executeNode,
  freshCatalogue,
  nodeExecutionRequest,
} from "./engine-fixtures";

const GRANTED = "acme.engineering.admin";
const UNGRANTED = "other.team.admin";

function buildLoopContext(
  kind: string,
  loop: Partial<GraphLoopMetadata>,
  engine: GraphExecutionEngine | undefined,
  metadata: Record<string, unknown> = {}
): GraphExecutionContext {
  const { body, maxIterations, timeoutMs, concurrency, ...rest } = loop;
  const node: GraphNodeInstance = {
    id: "LoopNode",
    kind,
    parameters: rest as Record<string, never>,
    loop: {
      body: body as GraphWorkflowDocument,
      maxIterations,
      timeoutMs,
      concurrency,
    },
  };
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
    display: { name: "Loop" },
    inputs: [],
    outputs: [],
    parameters: [],
    capabilities: ["loop"],
  };
  return new GraphExecutionContextClass(
    "run-1",
    undefined,
    "wf",
    document,
    node,
    manifest,
    ["LoopNode"],
    async () => {},
    metadata,
    engine
  );
}

function capturingEngine(): {
  engine: GraphExecutionEngine;
  calls: Array<{
    options: Record<string, unknown>;
    contextual: GraphExecutionContext | undefined;
  }>;
} {
  const calls: Array<{
    options: Record<string, unknown>;
    contextual: GraphExecutionContext | undefined;
  }> = [];
  const engine = {
    execute: async (
      _wf: unknown,
      _inputs: Record<string, unknown>,
      options: Record<string, unknown>,
      contextual: GraphExecutionContext
    ) => {
      calls.push({ options, contextual });
      return { outputs: { result: 1, state: false } };
    },
  } as unknown as GraphExecutionEngine;
  return { engine, calls };
}

function bodyDocument(
  id: string,
  namespace: string,
  inputPort = "item",
  outputPort = "result"
): GraphWorkflowDocument {
  return {
    id,
    name: id,
    inputs: [documentPort(inputPort)],
    outputs: [documentPort(outputPort)],
    nodes: [documentNode("probe", "auth.probe")],
    edges: [
      documentEdge(
        "e0",
        ["workflow", inputPort],
        ["node", "probe", "value"]
      ),
      documentEdge(
        "e1",
        ["node", "probe", "result"],
        ["workflow", outputPort]
      ),
    ],
    metadata: { auth: { namespaces: [namespace] } },
  };
}

async function authEngine(): Promise<GraphExecutionEngine> {
  const catalogue = freshCatalogue();
  await catalogue.register(
    defineGraphNode({
      manifest: {
        kind: "auth.probe",
        display: { name: "auth.probe" },
        inputs: [{ id: "value", label: "value", direction: "input" }],
        outputs: [{ id: "result", label: "result", direction: "output" }],
        parameters: [],
      },
      executor: {
        execute: () => ({ result: "ok" }),
      },
    })
  );
  return await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    authEnabled: true,
  });
}

describe("nested loop auth propagation (SAA-2079 M3)", () => {
  it("forwards the parent principal to a nested foreach body execution", async () => {
    const { engine, calls } = capturingEngine();
    const ctx = buildLoopContext(
      "core.loop.foreach",
      { body: {}, itemPort: "item", resultPort: "result" },
      engine,
      { user: "alice", namespaces: [GRANTED] }
    );

    await executeNode(
      GraphForeachLoopNode,
      nodeExecutionRequest({ items: [1] }),
      ctx
    );

    expect(calls).toHaveLength(1);
    expect((calls[0].options.auth as { namespaces?: string[] }).namespaces).toEqual([
      GRANTED,
    ]);
    expect(graphAuthDataOf(calls[0].contextual).namespaces).toEqual([GRANTED]);
  });

  it("forwards the parent principal to a nested while body execution", async () => {
    const { engine, calls } = capturingEngine();
    const ctx = buildLoopContext(
      "core.loop.while",
      {
        body: {},
        condition: { type: "truthy" },
      },
      engine,
      { user: "alice", namespaces: [GRANTED] }
    );

    await executeNode(
      GraphWhileLoopNode,
      nodeExecutionRequest({ state: true }),
      ctx
    );

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect((calls[0].options.auth as { namespaces?: string[] }).namespaces).toEqual([
      GRANTED,
    ]);
    expect(graphAuthDataOf(calls[0].contextual).namespaces).toEqual([GRANTED]);
  });

  it("executes a body workflow declaring a granted namespace inside a loop", async () => {
    const engine = await authEngine();
    const ctx = buildLoopContext(
      "core.loop.foreach",
      { body: bodyDocument("body-granted", GRANTED), itemPort: "item", resultPort: "result" },
      engine,
      { user: "alice", namespaces: [GRANTED] }
    );

    const out = await executeNode(
      GraphForeachLoopNode,
      nodeExecutionRequest({ items: [1] }),
      ctx
    );
    expect(out.iterations).toBe(1);
    expect(out.results).toEqual(["ok"]);
  });

  it("fails closed for a body workflow declaring an ungranted namespace", async () => {
    const engine = await authEngine();
    const ctx = buildLoopContext(
      "core.loop.foreach",
      {
        body: bodyDocument("body-ungranted", UNGRANTED),
        itemPort: "item",
        resultPort: "result",
      },
      engine,
      { user: "alice", namespaces: [GRANTED] }
    );

    await expect(
      executeNode(
        GraphForeachLoopNode,
        nodeExecutionRequest({ items: [1] }),
        ctx
      )
    ).rejects.toThrow(ForbiddenError);
  });
});
