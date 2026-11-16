/**
 * @module as-graph/tests/integration/graph/engineContracts.test
 * @summary Node-to-node contracts, proven through the real engine.
 * @description Every case here runs a canonical document through
 * `GraphExecutionEngine.execute`, including output validation and value
 * routing. Node-level tests that call `execute()` directly passed while these
 * workflows were broken, so each contract below is asserted end to end:
 * wired configuration ports, branch outputs, trigger payloads, fan-in,
 * nested-run failures, and binary values travelling as references.
 */
import { describe, it, expect } from "@jest/globals";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { document, edge, node, port } from "../../../src/workflows/builders";
import {
  ORDER_ANALYTICS_INPUTS,
  ORDER_ANALYTICS_REPORT,
  orderAnalyticsDocument,
} from "../../../src/workflows/basic/order-analytics.workflow";
import {
  isGraphBinaryReference,
  type GraphWorkflowDocument,
} from "../../../src/shared/graph";
import { bootFixtureEngine } from "../../fixtures/workflow-engine";
import { resolveDocument } from "../../unit/graph/engine-fixtures";

process.env["GRAPH_FILE_IO_BASE"] = mkdtempSync(
  join(tmpdir(), "as-graph-contracts-")
);

async function run(
  doc: GraphWorkflowDocument,
  inputs: Record<string, unknown> = {}
) {
  const { engine, catalogue } = await bootFixtureEngine();
  await resolveDocument(doc, catalogue);
  const result = await engine.execute(doc, inputs);
  return { engine, result };
}

describe("expose-as-port configuration", () => {
  const doc = document({
    id: "c-wired-config",
    inputs: [port("items"), port("max")],
    outputs: [port("out")],
    nodes: [node("limit", "core.data.limit", { maxItems: 5 })],
    edges: [
      edge("e1", ["workflow", "items"], ["node", "limit", "value"]),
      edge("e2", ["workflow", "max"], ["node", "limit", "maxItems"]),
      edge("e3", ["node", "limit", "result"], ["workflow", "out"]),
    ],
  });

  it("uses the value routed onto a configuration port over the filled one", async () => {
    const { result } = await run(doc, { items: [1, 2, 3, 4, 5, 6], max: 2 });
    expect(result.status).toBe("succeeded");
    expect(result.outputs.out).toEqual([1, 2]);
  });

  it("keeps the filled value when the port is not wired", async () => {
    const unwired = document({
      id: "c-filled-config",
      inputs: [port("items")],
      outputs: [port("out")],
      nodes: [node("limit", "core.data.limit", { maxItems: 3 })],
      edges: [
        edge("e1", ["workflow", "items"], ["node", "limit", "value"]),
        edge("e3", ["node", "limit", "result"], ["workflow", "out"]),
      ],
    });
    const { result } = await run(unwired, { items: [1, 2, 3, 4, 5] });
    expect(result.outputs.out).toEqual([1, 2, 3]);
  });
});

describe("branching", () => {
  const doc = document({
    id: "c-if-else",
    inputs: [port("order")],
    outputs: [port("out")],
    nodes: [
      node("if", "core.flow.if", {
        else: true,
        condition: {
          op: "gt",
          left: { path: "total" },
          right: { const: 10 },
        },
      }),
      node("big", "core.data.set", {
        includeOtherFields: true,
        assignments: [{ name: "size", type: "string", value: "big" }],
      }),
      node("small", "core.data.set", {
        includeOtherFields: true,
        assignments: [{ name: "size", type: "string", value: "small" }],
      }),
    ],
    edges: [
      edge("e1", ["workflow", "order"], ["node", "if", "value"]),
      edge("e2", ["node", "if", "then"], ["node", "big", "value"]),
      edge("e3", ["node", "if", "else"], ["node", "small", "value"]),
      edge("e4", ["node", "big", "result"], ["workflow", "out"]),
      edge("e5", ["node", "small", "result"], ["workflow", "out"]),
    ],
  });

  it("takes the then branch and skips the else branch", async () => {
    const { result } = await run(doc, { order: { total: 42 } });
    expect(result.status).toBe("succeeded");
    expect(result.outputs.out).toEqual({ total: 42, size: "big" });
    expect(result.nodeResults.small.status).toBe("skipped");
  });

  it("takes the else branch without failing output validation", async () => {
    const { result } = await run(doc, { order: { total: 3 } });
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.if.outputs).toEqual({ else: { total: 3 } });
    expect(result.outputs.out).toEqual({ total: 3, size: "small" });
    expect(result.nodeResults.big.status).toBe("skipped");
  });
});

describe("trigger payload", () => {
  const doc = document({
    id: "c-trigger",
    outputs: [port("out"), port("said")],
    nodes: [
      node("start", "core.trigger.manual"),
      node("chat", "core.trigger.chat"),
      node("delay", "core.flow.delay", { timeoutMs: 5 }),
    ],
    edges: [
      edge("e1", ["node", "start", "payload"], ["node", "delay", "value"]),
      edge("e2", ["node", "delay", "value"], ["workflow", "out"]),
      edge("e3", ["node", "chat", "message"], ["workflow", "said"]),
    ],
  });

  it("hands entry nodes the run inputs", async () => {
    const { result } = await run(doc, {
      payload: { id: 7 },
      message: "hello",
      sessionId: "s",
      userId: "u",
    });
    expect(result.status).toBe("succeeded");
    expect(result.outputs.out).toEqual({ id: 7 });
    expect(result.outputs.said).toBe("hello");
  });

  it("emits the whole run input when no payload field is sent", async () => {
    const single = document({
      id: "c-trigger-whole",
      outputs: [port("out")],
      nodes: [node("start", "core.trigger.manual")],
      edges: [edge("e1", ["node", "start", "payload"], ["workflow", "out"])],
    });
    const { result } = await run(single, { orderId: 9 });
    expect(result.outputs.out).toEqual({ orderId: 9 });
  });

  it("forwards a null payload as null, and really waits in the delay", async () => {
    const started = Date.now();
    const { result } = await run(doc, { payload: null });
    expect(result.outputs.out).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
  });
});

describe("fan-in", () => {
  it("appends item lists routed onto the same port", async () => {
    const doc = document({
      id: "c-fan-in",
      inputs: [port("a"), port("mode")],
      outputs: [port("out")],
      nodes: [node("merge", "core.data.merge", { mode: "append" })],
      edges: [
        edge("e1", ["workflow", "a"], ["node", "merge", "input"]),
        // A source port named like one of the node's configuration ports
        // must not overwrite that port.
        edge("e2", ["workflow", "mode"], ["node", "merge", "input"]),
        edge("e3", ["node", "merge", "result"], ["workflow", "out"]),
      ],
    });
    const { result } = await run(doc, { a: [1], mode: [2] });
    expect(result.status).toBe("succeeded");
    expect(result.outputs.out).toEqual([1, 2]);
  });
});

describe("nested runs", () => {
  const failingBody = document({
    id: "c-loop-body",
    inputs: [port("item")],
    outputs: [port("result")],
    nodes: [node("guard", "core.flow.if", {})],
    edges: [
      edge("b1", ["workflow", "item"], ["node", "guard", "value"]),
      edge("b2", ["node", "guard", "then"], ["workflow", "result"]),
    ],
  });

  it("fails the loop when an iteration's body fails", async () => {
    const doc = document({
      id: "c-loop-failure",
      inputs: [port("items")],
      outputs: [port("out")],
      nodes: [
        node(
          "loop",
          "core.loop.foreach",
          { itemPort: "item", resultPort: "result" },
          { loop: { body: failingBody } }
        ),
      ],
      edges: [
        edge("e1", ["workflow", "items"], ["node", "loop", "items"]),
        edge("e2", ["node", "loop", "completed"], ["workflow", "out"]),
      ],
    });
    const { result } = await run(doc, { items: [1, 2] });
    expect(result.status).toBe("failed");
    expect(result.nodeResults.loop.status).toBe("failed");
    expect(result.nodeResults.loop.error?.code).toBe("GRAPH_IF_NO_CONDITION");
    expect(result.nodeResults.loop.error?.message).toMatch(
      /foreach iteration 0 failed/
    );
  });
});

describe("binary values", () => {
  const doc = document({
    id: "c-binary",
    inputs: [port("rows")],
    outputs: [port("file"), port("parsed")],
    nodes: [
      node("csv", "core.io.convertToFile", {
        operation: "csv",
        fileName: "rows.csv",
      }),
      node("write", "core.io.writeBinaryFile", { fileName: "out/rows.csv" }),
      node("read", "core.io.readBinaryFile", {}),
      node("extract", "core.io.extractFromFile", { format: "csv" }),
    ],
    edges: [
      edge("e1", ["workflow", "rows"], ["node", "csv", "value"]),
      edge("e2", ["node", "csv", "result"], ["node", "write", "value"]),
      edge("e3", ["node", "write", "result"], ["node", "read", "value"]),
      edge("e4", ["node", "read", "result"], ["node", "extract", "value"]),
      edge("e5", ["node", "read", "result"], ["workflow", "file"]),
      edge("e6", ["node", "extract", "result"], ["workflow", "parsed"]),
    ],
  });
  const rows = [
    { id: "1", name: "a" },
    { id: "2", name: "b" },
  ];

  it("chains a writer into a reader and decodes the file it read", async () => {
    const { result } = await run(doc, { rows });
    expect(result.status).toBe("succeeded");
    expect(result.outputs.parsed).toEqual(rows);
  });

  it("carries references, never bytes, across every boundary", async () => {
    const { engine, result } = await run(doc, { rows });
    const file = result.outputs.file;
    expect(isGraphBinaryReference(file)).toBe(true);
    expect(file).toMatchObject({
      fileName: "rows.csv",
      mimeType: "text/csv",
      byteLength: 15,
    });
    const serialized = JSON.stringify({
      results: result.nodeResults,
      events: result.events,
    });
    expect(serialized).not.toContain(
      Buffer.from("id,name\n1,a\n2,b").toString("base64")
    );
    // Identical bytes produced by two nodes are stored once.
    expect(result.nodeResults.csv.outputs?.result).toMatchObject({
      id: (file as { id: string }).id,
    });
    const bytes = await engine.binaryStore?.read((file as { id: string }).id);
    expect(bytes?.toString("utf8")).toBe("id,name\n1,a\n2,b");
  });
});

describe("workbook files", () => {
  it.each(["xlsx", "ods"] as const)(
    "writes a %s workbook, reads it back from disk and keeps the cell types",
    async (format) => {
      const doc = document({
        id: `c-workbook-${format}`,
        inputs: [port("rows")],
        outputs: [port("file"), port("parsed")],
        nodes: [
          node("book", "core.io.convertToFile", {
            operation: format,
            sheetName: "Stock",
            fileName: `stock.${format}`,
          }),
          node("write", "core.io.writeBinaryFile", {
            fileName: `books/stock.${format}`,
            encoding: "auto",
          }),
          node("read", "core.io.readBinaryFile", {}),
          node("extract", "core.io.extractFromFile", { format }),
        ],
        edges: [
          edge("e1", ["workflow", "rows"], ["node", "book", "value"]),
          edge("e2", ["node", "book", "result"], ["node", "write", "value"]),
          edge("e3", ["node", "write", "result"], ["node", "read", "value"]),
          edge("e4", ["node", "read", "result"], ["node", "extract", "value"]),
          edge("e5", ["node", "read", "result"], ["workflow", "file"]),
          edge("e6", ["node", "extract", "result"], ["workflow", "parsed"]),
        ],
      });
      const rows = [
        { sku: "bolt", qty: 4, active: true },
        { sku: "nüt", qty: 9.5, active: false },
      ];
      const { result } = await run(doc, { rows });
      const failed = Object.values(result.nodeResults)
        .filter((entry) => entry.status === "failed")
        .map((entry) => `${entry.nodeId}: ${entry.error?.message}`);
      expect(failed).toEqual([]);
      // Numbers and booleans survive, unlike a CSV round trip.
      expect(result.outputs.parsed).toEqual(rows);
      expect(isGraphBinaryReference(result.outputs.file)).toBe(true);
    }
  );
});

describe("order-analytics demo workflow", () => {
  it("runs all fourteen steps and produces the expected report", async () => {
    const { result } = await run(orderAnalyticsDocument, ORDER_ANALYTICS_INPUTS);
    const failed = Object.values(result.nodeResults).filter(
      (entry) => entry.status === "failed"
    );
    expect(failed).toEqual([]);
    expect(result.status).toBe("succeeded");
    expect(result.outputs.report).toEqual(ORDER_ANALYTICS_REPORT);
    expect(result.nodeResults.segmented.outputs?.iterations).toBe(3);
    // The CSV survived the disk round trip: every parsed row matches its
    // source row, with only text-format type differences.
    expect(result.outputs.roundTripSame).toEqual(ORDER_ANALYTICS_REPORT);
    expect(result.outputs.roundTripDifferent).toEqual([]);
    expect(isGraphBinaryReference(result.outputs.file)).toBe(true);
  });
});
