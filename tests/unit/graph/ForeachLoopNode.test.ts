/**
 * @module as-graph/tests/unit/graph/ForeachLoopNode.test
 * @summary Unit tests for the Foreach loop node class's static execute
 * (slice + break support, DECAF-50 §4.26 R2-1).
 */
import { GraphForeachLoopNode, BreakFlowNode } from "../../../src/node";
import { GraphBreakSignal } from "../../../src/engine/errors/GraphBreakSignal";
import { GraphExecutionContext } from "../../../src/engine/execution/GraphExecutionContext";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { defineGraphNode } from "../../../src/engine/catalog/GraphNodeRegistration";
import { registerBuiltInGraphNodes } from "../../../src/engine/catalog/GraphBuiltInRegistrations";
import { GraphInputError } from "../../../src/engine/errors/GraphInputError";
import type {
  GraphNodeInstance,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import type { GraphResolvedNodeManifest } from "../../../src/shared/graph";
import {
  bootEngine,
  documentEdge,
  documentNode,
  documentPort,
  executeNode,
  freshCatalogue,
  nodeExecutionRequest,
  nodeExecutor,
} from "./engine-fixtures";

/**
 * Builds a minimal {@link GraphExecutionContext} for a Foreach node from a
 * loop-metadata bag: rule-6 configuration fields (itemPort, resultPort,
 * statePort, slice, ...) land in the instance `parameters`; body/maxIterations
 * live on `instance.loop` (DECAF-50 §4.4.5/§4.9).
 */
function buildContext(
  loopMeta: Record<string, unknown>,
  engine?: GraphExecutionEngine
): GraphExecutionContext {
  const { body, maxIterations, timeoutMs, concurrency, ...parameters } = loopMeta;
  const node: GraphNodeInstance = {
    id: "ForeachNode",
    kind: "core.loop.foreach",
    parameters: parameters as Record<string, never>,
    loop: { body: body as GraphWorkflowDocument, maxIterations: maxIterations as number | undefined, timeoutMs: timeoutMs as number | undefined, concurrency: concurrency as number | undefined },
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
    kind: "core.loop.foreach",
    display: { name: "Foreach" },
    inputs: [],
    outputs: [],
    parameters: [],
    capabilities: ["loop"],
  };
  return new GraphExecutionContext(
    "run-1",
    undefined,
    "wf",
    document,
    node,
    manifest,
    ["ForeachNode"],
    async () => {},
    {},
    engine
  );
}

/**
 * Builds a fake engine whose `execute` returns the item doubled on the
 * `result` port. When `breakAt` is set, the body throws a GraphBreakSignal
 * carrying the item on that iteration index.
 */
function buildEngine(breakAt: number | null = null): GraphExecutionEngine {
  return {
    execute: async (_wf: unknown, inputs: Record<string, unknown>) => {
      const index = inputs.index as number;
      if (breakAt !== null && index === breakAt) {
        throw new GraphBreakSignal(inputs.item);
      }
      return { outputs: { result: (inputs.item as number) * 2 } };
    },
  } as unknown as GraphExecutionEngine;
}

describe("GraphForeachLoopNode.execute", () => {
  it("iterates once per item and collects results", async () => {
    const engine = buildEngine();
    const executor = nodeExecutor(GraphForeachLoopNode);
    const ctx = buildContext({ body: {}, itemPort: "item", resultPort: "result" }, engine);
    const out = await executor.execute(
      nodeExecutionRequest({ items: [1, 2, 3] }),
      ctx
    );
    expect(out.results).toEqual([2, 4, 6]);
    expect(out.completed).toEqual([2, 4, 6]);
    expect(out.iterations).toBe(3);
    expect(out.broken).toBe(false);
  });

  it("rejects non-array items", async () => {
    const executor = nodeExecutor(GraphForeachLoopNode);
    const ctx = buildContext({ body: {} }, buildEngine());
    await expect(
      executor.execute(nodeExecutionRequest({ items: "nope" }), ctx)
    ).rejects.toBeInstanceOf(
      GraphInputError
    );
  });

  it("groups items into slices and iterates once per slice", async () => {
    const executor = nodeExecutor(GraphForeachLoopNode);
    const ctx = buildContext(
      { body: {}, slice: 2, itemPort: "item", resultPort: "result" },
      buildEngine()
    );
    const out = await executor.execute(
      nodeExecutionRequest({ items: [1, 2, 3, 4, 5] }),
      ctx
    );
    // 5 items / slice 2 => 3 iterations (slices: [1,2], [3,4], [5])
    expect(out.iterations).toBe(3);
    // body receives a slice array; mock doubles the slice array (NaN) — just check count
    expect(out.results).toHaveLength(3);
  });

  it("stops early when the body throws a GraphBreakSignal", async () => {
    const executor = nodeExecutor(GraphForeachLoopNode);
    const ctx = buildContext(
      { body: {}, itemPort: "item", resultPort: "result" },
      buildEngine(1)
    );
    const out = await executor.execute(
      nodeExecutionRequest({ items: [1, 2, 3, 4] }),
      ctx
    );
    // iteration 0 succeeds (result 2), iteration 1 breaks carrying item 2
    expect(out.broken).toBe(true);
    expect(out.iterations).toBe(2);
    expect(out.results).toEqual([2, 2]);
  });

  it("uses slice from input port over metadata", async () => {
    const executor = nodeExecutor(GraphForeachLoopNode);
    const ctx = buildContext(
      { body: {}, slice: 5, itemPort: "item", resultPort: "result" },
      buildEngine()
    );
    const out = await executor.execute(
      nodeExecutionRequest({ items: [1, 2, 3, 4], slice: 2 }),
      ctx
    );
    expect(out.iterations).toBe(2);
  });

  it("throws GRAPH_ENGINE_NOT_AVAILABLE when the context has no engine", async () => {
    const executor = nodeExecutor(GraphForeachLoopNode);
    const ctx = buildContext({ body: {} });
    await expect(
      executor.execute(nodeExecutionRequest({ items: [1] }), ctx)
    ).rejects.toThrow(/requires engine access/i);
  });
});

describe("BreakFlowNode.execute", () => {
  it("throws a GraphBreakSignal carrying the input value", () => {
    const executor = nodeExecutor(BreakFlowNode);
    const ctx = buildContext({});
    expect(() =>
      executor.execute(nodeExecutionRequest({ value: "stop" }), ctx)
    ).toThrow(GraphBreakSignal);
    try {
      executor.execute(nodeExecutionRequest({ value: "stop" }), ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(GraphBreakSignal);
      expect((err as GraphBreakSignal).details).toEqual({ value: "stop" });
    }
  });
});

describe("GraphForeachLoopNode.execute — real engine with a switch body (DECAF-50 §4.9 regression)", () => {
  /**
   * Builds a real engine over the built-in registrations plus two branch
   * executors that record their invocation and return the item label.
   */
  async function buildBranchEngine(
    onBranch: (branch: string, value: unknown) => void
  ): Promise<GraphExecutionEngine> {
    const catalogue = freshCatalogue();
    const engine = await bootEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
    });
    await registerBuiltInGraphNodes(catalogue);
    const registerBranch = (kind: string, branch: string) =>
      catalogue.register(
        defineGraphNode({
          manifest: {
            kind,
            display: { name: kind },
            inputs: [{ id: "value", label: "value", direction: "input" }],
            outputs: [{ id: "result", label: "result", direction: "output" }],
            parameters: [],
          },
          executor: {
            execute: (request: { inputs: Record<string, unknown> }) => {
              onBranch(branch, request.inputs.value);
              return {
                result: (request.inputs.value as { label: string }).label,
              };
            },
          } as never,
        })
      );
    await registerBranch("sample.foreach-even", "even");
    await registerBranch("sample.foreach-odd", "odd");
    return engine;
  }

  it("collects exactly one non-null result per item when each body iteration routes through a switch branch", async () => {
    const invocations: Array<{ branch: string; value: unknown }> = [];
    const engine = await buildBranchEngine((branch, value) =>
      invocations.push({ branch, value })
    );

    const bodyDocument: GraphWorkflowDocument = {
      id: "foreach-switch-body",
      name: "foreach-switch-body",
      inputs: [documentPort("item")],
      outputs: [documentPort("result")],
      nodes: [
        documentNode(
          "sw",
          "core.flow.switch",
          {
            cases: [
              {
                id: "even",
                label: "Even",
                outputPort: "even",
                condition: {
                  op: "eq",
                  left: { path: "even" },
                  right: { const: true },
                },
              },
            ],
            hasDefault: true,
          },
          {
            metadata: {
              switch: {
                cases: [
                  {
                    id: "even",
                    label: "Even",
                    outputPort: "even",
                    condition: {
                      op: "eq",
                      left: { path: "even" },
                      right: { const: true },
                    },
                  },
                ],
                defaultPort: "default",
                hasDefault: true,
              },
            },
          }
        ),
        documentNode("evenBranch", "sample.foreach-even"),
        documentNode("oddBranch", "sample.foreach-odd"),
      ],
      edges: [
        documentEdge("be_in", ["workflow", "item"], ["node", "sw", "value"]),
        documentEdge(
          "be_even",
          ["node", "sw", "even"],
          ["node", "evenBranch", "value"]
        ),
        documentEdge(
          "be_odd",
          ["node", "sw", "default"],
          ["node", "oddBranch", "value"]
        ),
        documentEdge(
          "be_out_even",
          ["node", "evenBranch", "result"],
          ["workflow", "result"]
        ),
        documentEdge(
          "be_out_odd",
          ["node", "oddBranch", "result"],
          ["workflow", "result"]
        ),
      ],
    };

    const items = [
      { even: true, label: "Hello" },
      { even: false, label: "World" },
      { even: true, label: "Foo" },
      { even: false, label: "Bar" },
      { even: true, label: "Baz" },
    ];

    const ctx = buildContext(
      { body: bodyDocument, itemPort: "item", resultPort: "result" },
      engine
    );
    const out = await executeNode(GraphForeachLoopNode, 
      nodeExecutionRequest({ items }),
      ctx
    );

    expect(out.completed).toEqual(["Hello", "World", "Foo", "Bar", "Baz"]);
    expect(out.results).toEqual(["Hello", "World", "Foo", "Bar", "Baz"]);
    expect(out.iterations).toBe(5);
    expect(invocations.map((entry) => entry.branch)).toEqual([
      "even",
      "odd",
      "even",
      "odd",
      "even",
    ]);
  });
});
