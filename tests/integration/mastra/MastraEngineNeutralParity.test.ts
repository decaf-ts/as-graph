/**
 * @module as-graph/tests/integration/mastra/MastraEngineNeutralParity.test
 * @summary The same document produces the same result on the local engine and
 * on the Mastra engine.
 * @description Engine-neutral node kinds (data, IO, flow, triggers, utility)
 * are declared once and adapted per engine. This suite boots the standalone
 * Mastra host the way `as-graph-server` does — real `@mastra/core` runtime, no
 * host step handlers — and runs the order-analytics demo and the trigger
 * fixtures through `GraphExecutionEngine.execute`, comparing against the
 * general engine.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test, type TestingModule } from "@nestjs/testing";
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphNodeCatalogue } from "../../../src/engine/catalog/GraphNodeCatalogue";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";
import {
  mastraEngineNeutralKinds,
  MASTRA_ENGINE_NEUTRAL_EXCLUDED_KINDS,
} from "../../../src/mastra/MastraEngineNeutralStepHandlers";
import { GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND } from "../../../src/node";
import { document, edge, node, port } from "../../../src/workflows/builders";
import { runFixtureDocument } from "../../fixtures/workflow-engine";
import { webhookFormFixture } from "../../../src/workflows/basic/webhook-form.workflow";
import { isGraphBinaryReference } from "../../../src/shared/graph";
import {
  resetGraphInjectables,
  resetGraphValueAdapter,
} from "../../unit/graph/engine-fixtures";

const OBSERVABILITY = "MASTRA__OBSERVABILITY__ENABLED";

/** A code-free data pipeline ending in a binary file round trip. */
const salesPipeline = document({
  id: "mastra-parity-sales",
  inputs: [port("sales"), port("regions")],
  outputs: [port("report"), port("file"), port("parsed")],
  nodes: [
    node("billable", "core.data.filter", {
      condition: { op: "gt", left: { path: "amount" }, right: { const: 0 } },
    }),
    node("perRegion", "core.data.summarize", {
      fieldsToSummarize: [{ aggregation: "sum", field: "amount" }],
      fieldsToSplitBy: "region",
    }),
    node("enriched", "core.data.merge", {
      mode: "combine",
      combineBy: "fields",
      joinField: "region",
      joinMode: "left",
    }),
    node("renamed", "core.data.renameKeys", {
      renames: [{ from: "sum_amount", to: "total" }],
    }),
    node("ranked", "core.data.sort", {
      sortFields: [{ field: "total", direction: "desc" }],
    }),
    node("csv", "core.io.convertToFile", {
      operation: "csv",
      fileName: "sales.csv",
    }),
    node("write", "core.io.writeBinaryFile", { fileName: "sales/sales.csv" }),
    node("read", "core.io.readBinaryFile", {}),
    node("extract", "core.io.extractFromFile", { format: "csv" }),
  ],
  edges: [
    edge("e1", ["workflow", "sales"], ["node", "billable", "value"]),
    edge("e2", ["node", "billable", "result"], ["node", "perRegion", "value"]),
    edge("e3", ["node", "perRegion", "result"], ["node", "enriched", "input"]),
    edge("e4", ["workflow", "regions"], ["node", "enriched", "input2"]),
    edge("e5", ["node", "enriched", "result"], ["node", "renamed", "value"]),
    edge("e6", ["node", "renamed", "result"], ["node", "ranked", "value"]),
    edge("e7", ["node", "ranked", "result"], ["node", "csv", "value"]),
    edge("e8", ["node", "csv", "result"], ["node", "write", "value"]),
    edge("e9", ["node", "write", "result"], ["node", "read", "value"]),
    edge("e10", ["node", "read", "result"], ["node", "extract", "value"]),
    edge("e11", ["node", "ranked", "result"], ["workflow", "report"]),
    edge("e12", ["node", "read", "result"], ["workflow", "file"]),
    edge("e13", ["node", "extract", "result"], ["workflow", "parsed"]),
  ],
});

describe("Mastra engine — engine-neutral node parity", () => {
  let moduleRef: TestingModule;
  let engine: GraphExecutionEngine;
  let observabilityOriginal: string | undefined;

  beforeAll(async () => {
    process.env["GRAPH_FILE_IO_BASE"] = mkdtempSync(
      join(tmpdir(), "as-graph-mastra-parity-")
    );
    observabilityOriginal = process.env[OBSERVABILITY];
    process.env[OBSERVABILITY] = "false";
    resetGraphInjectables();
    resetGraphValueAdapter();
    const [{ Mastra }, { InMemoryStore }] = await Promise.all([
      import("@mastra/core/mastra"),
      import("@mastra/core/storage"),
    ]);
    const runtime = new (Mastra as unknown as new (
      options: Record<string, unknown>
    ) => unknown)({
      storage: new (InMemoryStore as unknown as new () => unknown)(),
    });
    const host = await createGraphBackendHost({
      variant: "mastra",
      mastra: { mastra: runtime },
      base: {
        initAdapter: true,
        runs: { auth: "optional", allowAnonymousAccess: true },
        workflows: { auth: "optional", allowAnonymousAccess: true },
        catalogue: { auth: "optional" },
        engines: { auth: "optional" },
      },
    });
    moduleRef = await Test.createTestingModule({
      imports: [GraphExecutionModule.forRoot(host.moduleOptions)],
    }).compile();
    await moduleRef.init();
    engine = moduleRef.get(GraphExecutionEngine);
  });

  afterAll(async () => {
    await moduleRef?.close();
    GraphExecutionBackendRegistry.clear();
    if (observabilityOriginal === undefined) delete process.env[OBSERVABILITY];
    else process.env[OBSERVABILITY] = observabilityOriginal;
  });

  it("adapts every engine-neutral kind except the structurally translated ones", () => {
    const adapted = new Set(mastraEngineNeutralKinds());
    const neutral = Object.keys(GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND).filter(
      (kind) => !kind.startsWith("core.agent")
    );
    const missing = neutral.filter(
      (kind) =>
        !adapted.has(kind) && !MASTRA_ENGINE_NEUTRAL_EXCLUDED_KINDS.includes(kind)
    );
    expect(missing).toEqual([]);
    expect(adapted.has("core.data.filter")).toBe(true);
    expect(adapted.has("core.io.httpRequest")).toBe(true);
    expect(adapted.has("core.utility.code")).toBe(true);
  });

  it("blacklists the kinds Mastra cannot run: not in the catalogue, rejected by validation", async () => {
    const catalogue = moduleRef.get(GraphNodeCatalogue);
    const kinds = catalogue.listManifests().map((manifest) => manifest.kind);
    expect(kinds).not.toContain("core.flow.break");
    expect(kinds).toContain("core.loop.foreach");
    expect(kinds).toContain("core.agent");

    const doc = document({
      id: "mastra-parity-break",
      inputs: [port("items")],
      outputs: [],
      nodes: [node("stop", "core.flow.break")],
      edges: [edge("e1", ["workflow", "items"], ["node", "stop", "value"])],
    });
    const validation = await engine.validateWorkflowDocument(doc);
    expect(validation.valid).toBe(false);
    expect(JSON.stringify(validation.issues)).toContain("core.flow.break");
  });

  it("runs a data + file pipeline with the same outputs as the local engine", async () => {
    const inputs = {
      sales: [
        { region: "north", amount: 40 },
        { region: "south", amount: 0 },
        { region: "north", amount: 60 },
        { region: "west", amount: 25 },
      ],
      regions: [
        { region: "north", manager: "Ada" },
        { region: "west", manager: "Linus" },
      ],
    };
    const mastra = await engine.execute(salesPipeline, inputs);
    const failed = Object.values(mastra.nodeResults)
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.nodeId}: ${entry.error?.message}`);
    expect(failed).toEqual([]);
    expect(mastra.status).toBe("succeeded");

    const local = await runFixtureDocument(salesPipeline, inputs);
    expect(local.status).toBe("succeeded");

    const expected = [
      { region: "north", manager: "Ada", total: 100 },
      { region: "west", manager: "Linus", total: 25 },
    ];
    expect(local.outputs.report).toEqual(expected);
    expect(mastra.outputs.report).toEqual(expected);
    expect(mastra.outputs.parsed).toEqual(local.outputs.parsed);
    expect(isGraphBinaryReference(mastra.outputs.file)).toBe(true);
    expect(mastra.outputs.file).toEqual(local.outputs.file);
  });

  it("emits the trigger payload and really delays, like the local engine", async () => {
    const result = await engine.execute(
      webhookFormFixture.document,
      webhookFormFixture.inputs ?? {}
    );
    expect(result.status).toBe("succeeded");
    expect(result.outputs).toMatchObject(
      webhookFormFixture.expectedOutputs ?? {}
    );
  });

  it("evaluates code host-side: code node, map node, code condition and value template", async () => {
    const doc = document({
      id: "mastra-parity-code",
      inputs: [port("rows"), port("factor")],
      outputs: [port("out"), port("label")],
      nodes: [
        node(
          "scale",
          "core.utility.code",
          {},
          {
            inputBindings: {
              code: {
                mode: "literal",
                value:
                  "return $input.data.map((row) => ({ ...row, total: row.qty * row.price }));",
              },
            },
          }
        ),
        node("gate", "core.flow.if", {
          else: true,
          condition: {
            type: "code",
            code: "return $input.value.length > 1;",
          },
        }),
        node("names", "core.utility.map", { expression: "$item.sku.toUpperCase()" }),
        node("label", "core.data.set", {
          includeOtherFields: false,
          assignments: [
            {
              name: "text",
              type: "string",
              value: { mode: "template", expression: "{{ $input.value.length }} skus" },
            },
          ],
        }),
      ],
      edges: [
        edge("e1", ["workflow", "rows"], ["node", "scale", "data"]),
        edge("e2", ["node", "scale", "result"], ["node", "gate", "value"]),
        edge("e3", ["node", "gate", "then"], ["node", "names", "value"]),
        edge("e4", ["node", "names", "result"], ["workflow", "out"]),
        edge("e5", ["node", "names", "result"], ["node", "label", "value"]),
        edge("e6", ["node", "label", "result"], ["workflow", "label"]),
      ],
    });
    const inputs = {
      rows: [
        { sku: "bolt", qty: 2, price: 3 },
        { sku: "nut", qty: 5, price: 1 },
      ],
    };
    const mastra = await engine.execute(doc, inputs);
    const failed = Object.values(mastra.nodeResults)
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.nodeId}: ${entry.error?.message}`);
    expect(failed).toEqual([]);
    expect(mastra.status).toBe("succeeded");
    expect(mastra.outputs.out).toEqual(["BOLT", "NUT"]);
    const local = await runFixtureDocument(doc, inputs);
    expect(local.outputs.out).toEqual(mastra.outputs.out);
    expect(local.outputs.label).toEqual(mastra.outputs.label);
  });

  it("runs a while loop with a code condition", async () => {
    const body = document({
      id: "mastra-parity-while-body",
      inputs: [port("in")],
      outputs: [port("out")],
      nodes: [
        node(
          "inc",
          "core.utility.code",
          {},
          { inputBindings: { code: { mode: "literal", value: "return { n: $input.data.n + 1 };" } } }
        ),
      ],
      edges: [
        edge("b1", ["workflow", "in"], ["node", "inc", "data"]),
        edge("b2", ["node", "inc", "result"], ["workflow", "out"]),
      ],
    });
    const doc = document({
      id: "mastra-parity-while-code",
      inputs: [port("start")],
      outputs: [port("end")],
      nodes: [
        node(
          "loop",
          "core.loop.while",
          {
            inputPort: "in",
            outputPort: "out",
            condition: { type: "code", code: "return $input.n < 3;" },
          },
          { loop: { body } }
        ),
      ],
      edges: [
        edge("e1", ["workflow", "start"], ["node", "loop", "state"]),
        edge("e2", ["node", "loop", "state"], ["workflow", "end"]),
      ],
    });
    const result = await engine.execute(doc, { start: { n: 0 } });
    expect(result.status).toBe("succeeded");
    expect(result.outputs.end).toEqual({ n: 3 });
  });
});
