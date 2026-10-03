/**
 * @module as-graph/tests/unit/graph/LoopMaxIterationsClamp.test
 * @summary Unit tests for the loop-iteration cap clamp (SAA-2079 M2).
 * @description Covers the `resolveLoopMaxIterations` helper directly, its wiring
 * through the foreach/while node classes via `GraphExecutionContext.limits`, and the
 * engine's default/overridden limit resolution.
 */
import { GraphForeachLoopNode, GraphWhileLoopNode } from "../../../src/node";
import { resolveLoopMaxIterations } from "../../../src/node/flow/loop/loop-metadata";
import {
  GRAPH_DEFAULT_MAX_FOREACH_ITERATIONS,
  GRAPH_DEFAULT_MAX_LOOP_ITERATIONS,
  GRAPH_MAX_FOREACH_ITERATIONS,
  GRAPH_MAX_LOOP_ITERATIONS,
} from "../../../src/engine/constants";
import { GraphInputError } from "../../../src/engine/errors/GraphInputError";
import { GraphLoopLimitError } from "../../../src/engine/errors/GraphLoopLimitError";
import { GraphExecutionContext } from "../../../src/engine/execution/GraphExecutionContext";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { defineGraphNode } from "../../../src/engine/catalog/GraphNodeRegistration";
import type {
  GraphExecutionLimits,
  GraphLoopMetadata,
} from "../../../src/engine/types";
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
  freshCatalogue,
  nodeExecutionRequest,
  nodeExecutor,
} from "./engine-fixtures";

function buildLoopContext(
  kind: string,
  loop: Partial<GraphLoopMetadata>,
  engine?: GraphExecutionEngine,
  limits?: GraphExecutionLimits,
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
  return new GraphExecutionContext(
    "run-1",
    undefined,
    "wf",
    document,
    node,
    manifest,
    ["LoopNode"],
    async () => {},
    metadata,
    engine,
    undefined,
    limits
  );
}

/** Fake engine that doubles the current item on the `result` port. */
function foreachEngine(): GraphExecutionEngine {
  return {
    execute: async (_wf: unknown, inputs: Record<string, unknown>) => ({
      outputs: { result: (inputs.item as number) * 2 },
    }),
  } as unknown as GraphExecutionEngine;
}

/** Fake engine that always returns a truthy state, so `while` never self-terminates. */
function whileEngine(): GraphExecutionEngine {
  return {
    execute: async () => ({ outputs: { state: true } }),
  } as unknown as GraphExecutionEngine;
}

const LOOP_LIMITS: GraphExecutionLimits = {
  maxLoopIterations: GRAPH_MAX_LOOP_ITERATIONS,
  maxForeachIterations: GRAPH_MAX_FOREACH_ITERATIONS,
};

describe("resolveLoopMaxIterations (SAA-2079 M2)", () => {
  it("resolves an unset value to min(nodeFallback, engineLimit)", () => {
    expect(
      resolveLoopMaxIterations(
        undefined,
        GRAPH_MAX_LOOP_ITERATIONS,
        GRAPH_DEFAULT_MAX_LOOP_ITERATIONS,
        "while"
      )
    ).toBe(
      Math.min(GRAPH_DEFAULT_MAX_LOOP_ITERATIONS, GRAPH_MAX_LOOP_ITERATIONS)
    );
    expect(
      resolveLoopMaxIterations(
        undefined,
        50,
        GRAPH_DEFAULT_MAX_LOOP_ITERATIONS,
        "while"
      )
    ).toBe(50);
    expect(
      resolveLoopMaxIterations(
        null,
        50,
        GRAPH_DEFAULT_MAX_LOOP_ITERATIONS,
        "until"
      )
    ).toBe(50);
  });

  it("clamps a configured value above the engine limit to the engine limit", () => {
    expect(
      resolveLoopMaxIterations(
        5000,
        GRAPH_MAX_FOREACH_ITERATIONS,
        GRAPH_DEFAULT_MAX_FOREACH_ITERATIONS,
        "foreach"
      )
    ).toBe(5000);
    expect(
      resolveLoopMaxIterations(
        5000,
        100,
        GRAPH_DEFAULT_MAX_FOREACH_ITERATIONS,
        "foreach"
      )
    ).toBe(100);
    expect(
      resolveLoopMaxIterations(
        2000,
        1000,
        GRAPH_DEFAULT_MAX_LOOP_ITERATIONS,
        "while"
      )
    ).toBe(1000);
  });

  it("floors a fractional configured value", () => {
    expect(resolveLoopMaxIterations(3.9, 100, 10, "while")).toBe(3);
  });

  it("throws GraphInputError for non-finite or non-positive values", () => {
    for (const bad of ["abc", -1, 0, NaN, Infinity, -Infinity]) {
      expect(() => resolveLoopMaxIterations(bad, 1000, 100, "while")).toThrow(
        GraphInputError
      );
    }
  });
});

describe("foreach iteration clamp wiring (SAA-2079 M2)", () => {
  it("clamps an unset maxIterations to the engine ceiling", async () => {
    const executor = nodeExecutor(GraphForeachLoopNode);
    const ctx = buildLoopContext(
      "core.loop.foreach",
      { body: {} },
      foreachEngine(),
      { maxLoopIterations: 1000, maxForeachIterations: 2 }
    );
    await expect(
      executor.execute(nodeExecutionRequest({ items: [1, 2, 3] }), ctx)
    ).rejects.toBeInstanceOf(GraphLoopLimitError);
  });

  it("clamps a configured value above the engine ceiling", async () => {
    const executor = nodeExecutor(GraphForeachLoopNode);
    const ctx = buildLoopContext(
      "core.loop.foreach",
      { body: {}, maxIterations: 5000 },
      foreachEngine(),
      { maxLoopIterations: 1000, maxForeachIterations: 100 }
    );
    const items = Array.from({ length: 101 }, (_, i) => i);
    await expect(
      executor.execute(nodeExecutionRequest({ items }), ctx)
    ).rejects.toBeInstanceOf(GraphLoopLimitError);

    const permissive = buildLoopContext(
      "core.loop.foreach",
      { body: {}, maxIterations: 5000 },
      foreachEngine(),
      { maxLoopIterations: 1000, maxForeachIterations: 10000 }
    );
    const out = await executor.execute(
      nodeExecutionRequest({ items: [1, 2, 3] }),
      permissive
    );
    expect(out.iterations).toBe(3);
  });

  it("throws GraphInputError for a non-positive configured maxIterations", async () => {
    const executor = nodeExecutor(GraphForeachLoopNode);
    const ctx = buildLoopContext(
      "core.loop.foreach",
      { body: {}, maxIterations: -1 },
      foreachEngine(),
      LOOP_LIMITS
    );
    await expect(
      executor.execute(nodeExecutionRequest({ items: [1, 2, 3] }), ctx)
    ).rejects.toBeInstanceOf(GraphInputError);
  });
});

describe("while iteration clamp wiring (SAA-2079 M2)", () => {
  it("clamps an unset maxIterations to the engine ceiling", async () => {
    const executor = nodeExecutor(GraphWhileLoopNode);
    const ctx = buildLoopContext(
      "core.loop.while",
      { body: {}, condition: { type: "truthy" } },
      whileEngine(),
      { maxLoopIterations: 2, maxForeachIterations: 10000 }
    );
    await expect(
      executor.execute(nodeExecutionRequest({ state: true }), ctx)
    ).rejects.toBeInstanceOf(GraphLoopLimitError);
  });

  it("throws GraphInputError for a non-positive configured maxIterations", async () => {
    const executor = nodeExecutor(GraphWhileLoopNode);
    const ctx = buildLoopContext(
      "core.loop.while",
      { body: {}, maxIterations: -1, condition: { type: "truthy" } },
      whileEngine(),
      LOOP_LIMITS
    );
    await expect(
      executor.execute(nodeExecutionRequest({ state: true }), ctx)
    ).rejects.toBeInstanceOf(GraphInputError);
  });
});

describe("GraphExecutionContext.limits (SAA-2079 M2)", () => {
  async function captureLimits(
    options: { maxLoopIterations?: number; maxForeachIterations?: number } = {}
  ): Promise<GraphExecutionLimits | undefined> {
    const catalogue = freshCatalogue();
    let captured: GraphExecutionLimits | undefined;
    await catalogue.register(
      defineGraphNode({
        manifest: {
          kind: "limits.probe",
          display: { name: "limits.probe" },
          inputs: [{ id: "value", label: "value", direction: "input" }],
          outputs: [{ id: "result", label: "result", direction: "output" }],
          parameters: [],
        },
        executor: {
          execute: (_request, context) => {
            captured = context.limits;
            return { result: "ok" };
          },
        },
      })
    );
    const engine = await bootEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
    });
    const document: GraphWorkflowDocument = {
      id: "limits-wf",
      name: "limits-wf",
      inputs: [documentPort("value")],
      outputs: [documentPort("result")],
      nodes: [documentNode("probe", "limits.probe")],
      edges: [
        documentEdge("e0", ["workflow", "value"], ["node", "probe", "value"]),
        documentEdge("e1", ["node", "probe", "result"], ["workflow", "result"]),
      ],
    };
    const result = await engine.execute(document, { value: 1 }, options);
    expect(result.status).toBe("succeeded");
    return captured;
  }

  it("exposes the engine default limits", async () => {
    expect(await captureLimits()).toEqual({
      maxLoopIterations: GRAPH_MAX_LOOP_ITERATIONS,
      maxForeachIterations: GRAPH_MAX_FOREACH_ITERATIONS,
    });
  });

  it("exposes per-run overrides", async () => {
    expect(
      await captureLimits({ maxLoopIterations: 5, maxForeachIterations: 7 })
    ).toEqual({ maxLoopIterations: 5, maxForeachIterations: 7 });
  });
});
