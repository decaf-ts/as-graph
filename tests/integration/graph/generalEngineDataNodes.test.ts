/**
 * @module as-graph/tests/integration/graph/generalEngineDataNodes.test
 * @summary Integration coverage for the SAA-746 Stage 1 data nodes.
 * @description Proves the planner layers a two-input `core.data.merge` fan-in
 * after both producers, that append/combine/join execution modes work through
 * the real engine, and that `core.data.dataTable` persists insert/get/list/
 * upsert/delete/clear rows through `GraphDataTableRepository` over a RAM
 * adapter shared across repository instances (cross-run table persistence).
 */
import { describe, it, expect, beforeEach } from "@jest/globals";

import type { GraphExecutionValues } from "../../../src/engine/types";
import type { GraphNodeExecutionRequest } from "../../../src/engine/types";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { GraphExecutionPlanner } from "../../../src/engine/planning/GraphExecutionPlanner";
import { registerBuiltInGraphNodes } from "../../../src/engine/catalog/GraphBuiltInRegistrations";
import { DataTableNode } from "../../../src/node/data/data-table/node";
import {
  createGraphDataTableRepository,
  type GraphDataTableRepository,
} from "../../../src/engine/store/GraphDataTableRepository";
import { createRamGraphAdapter } from "../../../src/ram";
import {
  bootEngine,
  demoCatalogue,
  documentEdge,
  documentNode,
  documentPort,
  executeNode,
  resolveDocument,
  nodeExecutionRequest,
} from "../../unit/graph/engine-fixtures";
import { buildNodeContext } from "../../unit/graph/nodes/node-test-utils";

type Executors = Parameters<typeof demoCatalogue>[0];

function mergeExecutors(): Executors {
  return {
    "test.source": {
      execute: (request: GraphNodeExecutionRequest) => ({
        out: request.parameters["value"],
      }),
    },
  } as Executors;
}

async function bootMergeEngine(): Promise<{
  engine: GraphExecutionEngine;
  catalogue: Awaited<ReturnType<typeof demoCatalogue>>;
}> {
  const catalogue = await demoCatalogue(mergeExecutors());
  const engine = await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
  });
  return { engine, catalogue };
}

function mergeDocument(parameters: Record<string, unknown>): GraphWorkflowDocument {
  return {
    id: "wf-merge",
    name: "wf-merge",
    inputs: [],
    outputs: [documentPort("result")],
    nodes: [
      documentNode("left", "test.source", { value: [1, 2] }),
      documentNode("right", "test.source", { value: [3, 4] }),
      documentNode("merge", "core.data.merge", parameters),
    ],
    edges: [
      documentEdge("e-left", ["node", "left", "out"], ["node", "merge", "input"]),
      documentEdge("e-right", ["node", "right", "out"], ["node", "merge", "input2"]),
      documentEdge("e-out", ["node", "merge", "result"], ["workflow", "result"]),
    ],
  };
}

function joinDocument(): GraphWorkflowDocument {
  return {
    id: "wf-merge-fields",
    name: "wf-merge-fields",
    inputs: [],
    outputs: [documentPort("result")],
    nodes: [
      documentNode("left", "test.source", {
        value: [
          { id: 1, left: "a" },
          { id: 2, left: "b" },
        ],
      }),
      documentNode("right", "test.source", {
        value: [
          { id: 2, right: "x" },
          { id: 3, right: "y" },
        ],
      }),
      documentNode("merge", "core.data.merge", {
        mode: "combine",
        combineBy: "fields",
        joinField: "id",
        joinMode: "outer",
      }),
    ],
    edges: [
      documentEdge("e-left", ["node", "left", "out"], ["node", "merge", "input"]),
      documentEdge("e-right", ["node", "right", "out"], ["node", "merge", "input2"]),
      documentEdge("e-out", ["node", "merge", "result"], ["workflow", "result"]),
    ],
  };
}

describe("core.data.merge planner layering", () => {
  it("joins both inputs in the layer after both producers", async () => {
    const { engine, catalogue } = await bootMergeEngine();
    await registerBuiltInGraphNodes(catalogue);

    const resolved = await resolveDocument(mergeDocument({ mode: "append" }), catalogue);
    const plan = await new GraphExecutionPlanner().plan(resolved);

    expect(plan.layers).toHaveLength(2);
    expect(plan.layers[0].nodes.map((node) => node.id).sort()).toEqual([
      "left",
      "right",
    ]);
    expect(plan.layers[1].nodes.map((node) => node.id)).toEqual(["merge"]);

    const incoming = plan.incomingByNode.get("merge") ?? [];
    expect(
      incoming
        .map((edge) => `${edge.sourceNodeId}.${edge.sourcePort}->${edge.targetPort}`)
        .sort()
    ).toEqual(["left.out->input", "right.out->input2"]);

    const result = await engine.execute(mergeDocument({ mode: "append" }), {});
    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toEqual([1, 2, 3, 4]);
    expect(result.nodeResults.merge.inputs).toEqual({
      input: [1, 2],
      input2: [3, 4],
    });
  });

  it("runs field joins through the engine after the fan-in completes", async () => {
    const { engine, catalogue } = await bootMergeEngine();
    await registerBuiltInGraphNodes(catalogue);

    const result = await engine.execute(joinDocument(), {});
    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toEqual([
      { id: 1, left: "a" },
      { id: 2, left: "b", right: "x" },
      { id: 3, right: "y" },
    ]);
    expect(result.nodeResults.merge.inputs).toEqual({
      input: [
        { id: 1, left: "a" },
        { id: 2, left: "b" },
      ],
      input2: [
        { id: 2, right: "x" },
        { id: 3, right: "y" },
      ],
    });
  });
});

describe("core.data.dataTable over GraphDataTableRepository (RAM)", () => {
  let adapter: Awaited<ReturnType<typeof createRamGraphAdapter>>;
  let repository: GraphDataTableRepository;

  async function fakeEngine(
    store: GraphDataTableRepository
  ): Promise<GraphExecutionEngine> {
    return { dataTableStore: store } as unknown as GraphExecutionEngine;
  }

  function run(
    engine: GraphExecutionEngine,
    parameters: Record<string, unknown>,
    inputs: Record<string, unknown> = {}
  ): GraphExecutionValues | Promise<GraphExecutionValues> {
    return executeNode(
      DataTableNode,
      nodeExecutionRequest(inputs),
      buildNodeContext("core.data.dataTable", { parameters, engine })
    );
  }

  beforeEach(async () => {
    adapter = await createRamGraphAdapter(`saa949-datatable-${Date.now()}`);
    repository = createGraphDataTableRepository(adapter);
  });

  it("supports insert/get/list/upsert/delete/clear", async () => {
    const engine = await fakeEngine(repository);

    const inserted = (await run(
      engine,
      { operation: "insert", tableName: "users", rowIdField: "id" },
      {
        value: [
          { id: "u1", name: "Ada" },
          { id: "u2", name: "Grace" },
        ],
      }
    )) as { result: Record<string, unknown>[] };
    expect(inserted.result).toEqual([
      { id: "u1", name: "Ada" },
      { id: "u2", name: "Grace" },
    ]);

    expect(
      (await run(engine, { operation: "get", tableName: "users", rowId: "u1" }) as {
        result: unknown;
      }).result
    ).toEqual({ id: "u1", name: "Ada" });

    expect(
      (await run(engine, { operation: "list", tableName: "users", limit: 1 }) as {
        result: unknown[];
        count: number;
      })
    ).toEqual({ result: [{ id: "u1", name: "Ada" }], count: 1 });

    const upserted = (await run(
      engine,
      { operation: "upsert", tableName: "users", rowId: "u2" },
      { value: { id: "u2", name: "Grace Hopper" } }
    )) as { result: Record<string, unknown>[] };
    expect(upserted.result).toEqual([{ id: "u2", name: "Grace Hopper" }]);

    expect(
      (await run(engine, { operation: "delete", tableName: "users", rowId: "u1" }) as {
        result: boolean;
        count: number;
      })
    ).toEqual({ result: true, count: 1 });

    expect(
      (await run(engine, { operation: "clear", tableName: "users" }) as {
        result: number;
        count: number;
      })
    ).toEqual({ result: 1, count: 1 });

    expect(
      (await run(engine, { operation: "list", tableName: "users" }) as {
        result: unknown[];
      }).result
    ).toEqual([]);
  });

  it("persists rows across repository instances backed by the same adapter", async () => {
    await repository.insertRow("people", "p1", { name: "Ada" });

    const secondRunRepository = createGraphDataTableRepository(adapter);
    expect(await secondRunRepository.readRow("people", "p1")).toEqual({
      id: "p1",
      name: "Ada",
    });

    const secondEngine = await fakeEngine(secondRunRepository);
    expect(
      (await run(secondEngine, { operation: "list", tableName: "people" }) as {
        result: unknown[];
      }).result
    ).toEqual([{ id: "p1", name: "Ada" }]);
  });

  it("isolates tables on the same adapter", async () => {
    await repository.insertRow("a", "1", { table: "a" });
    await repository.insertRow("b", "1", { table: "b" });
    expect(await repository.listRows("a")).toEqual([{ id: "1", table: "a" }]);
    expect(await repository.listRows("b")).toEqual([{ id: "1", table: "b" }]);
  });

  it("rejects invalid table names and missing row ids", async () => {
    await expect(
      repository.insertRow("bad table", "1", {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_DATA_TABLE_INVALID_NAME" });

    const engine = await fakeEngine(repository);
    await expect(
      run(engine, { operation: "get", tableName: "users" })
    ).rejects.toMatchObject({ graphCode: "GRAPH_DATA_TABLE_ROW_ID_REQUIRED" });
    await expect(
      run(engine, { operation: "delete", tableName: "users" })
    ).rejects.toMatchObject({ graphCode: "GRAPH_DATA_TABLE_ROW_ID_REQUIRED" });
    await expect(
      run(engine, { operation: "bogus", tableName: "users" })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_DATA_TABLE_UNSUPPORTED_OPERATION",
    });
  });
});
