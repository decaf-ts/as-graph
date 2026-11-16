/**
 * @module as-graph/workflows/basic/order-analytics.workflow
 * @summary Order-analytics demo workflow: a realistic data pipeline over the
 * engine-neutral data, IO, flow and loop node kinds.
 * @description Exercises the default data flow (`value` → `result`) across
 * fourteen transformation steps, a fan-in join, a per-item loop with a nested
 * branch, and a binary file round trip (rows → CSV file → disk → file →
 * rows). It is the interaction fixture for the general engine: every edge
 * carries the previous node's default output into the next node's default
 * input, so a break in any node's data contract fails the whole run.
 *
 * Pipeline:
 *
 * 1. `lines` — split each order into one row per order line.
 * 2. `priced` — compute `lineTotal` per row (code node).
 * 3. `billable` — drop zero-value rows (filter).
 * 4. `perCustomer` — sum and count per customer (summarize).
 * 5. `enriched` — join the customer master data on `customer` (merge).
 * 6. `renamed` → `ranked` — rename the aggregate keys, sort by revenue.
 * 7. `segmented` — loop every customer; the body branches on the revenue
 *    threshold and stamps the segment (foreach + if + set).
 * 8. `top` — keep the best two (limit).
 * 9. `csv` → `write` → `read` → `parsed` — binary round trip through disk.
 * 10. `roundTrip` — prove the parsed rows match the pre-file rows
 *     (compare datasets).
 */
import { document, edge, node, port } from "../builders";
import type { GraphWorkflowFixture } from "../types";

/** Code-node body computing the per-line total. */
const PRICE_CODE =
  "return $input.data.map((row) => ({ ...row, lineTotal: row.line.qty * row.line.price }));";

/** Loop body: one customer row in, the same row stamped with its segment out. */
const segmentBody = document({
  id: "fixture-order-analytics-segment-body",
  name: "fixture-order-analytics-segment-body",
  inputs: [port("item")],
  outputs: [port("result")],
  nodes: [
    node("isKey", "core.flow.if", {
      else: true,
      condition: {
        op: "gte",
        left: { path: "revenue" },
        right: { const: 100 },
      },
    }),
    node("key", "core.data.set", {
      includeOtherFields: true,
      assignments: [{ name: "segment", type: "string", value: "key" }],
    }),
    node("standard", "core.data.set", {
      includeOtherFields: true,
      assignments: [{ name: "segment", type: "string", value: "standard" }],
    }),
  ],
  edges: [
    edge("s1", ["workflow", "item"], ["node", "isKey", "value"]),
    edge("s2", ["node", "isKey", "then"], ["node", "key", "value"]),
    edge("s3", ["node", "isKey", "else"], ["node", "standard", "value"]),
    edge("s4", ["node", "key", "result"], ["workflow", "result"]),
    edge("s5", ["node", "standard", "result"], ["workflow", "result"]),
  ],
});

/** The order-analytics demo document. */
export const orderAnalyticsDocument = document({
  id: "fixture-order-analytics",
  name: "fixture-order-analytics",
  inputs: [port("orders"), port("customers")],
  outputs: [
    port("report"),
    port("file"),
    port("roundTripSame"),
    port("roundTripDifferent"),
  ],
  nodes: [
    node("lines", "core.data.splitOut", {
      field: "lines",
      include: "allOtherFields",
      destinationField: "line",
    }),
    node(
      "priced",
      "core.utility.code",
      {},
      { inputBindings: { code: { mode: "literal", value: PRICE_CODE } } }
    ),
    node("billable", "core.data.filter", {
      condition: {
        op: "gt",
        left: { path: "lineTotal" },
        right: { const: 0 },
      },
    }),
    node("perCustomer", "core.data.summarize", {
      fieldsToSummarize: [
        { aggregation: "sum", field: "lineTotal" },
        { aggregation: "count", field: "lineTotal" },
      ],
      fieldsToSplitBy: "customer",
    }),
    node("enriched", "core.data.merge", {
      mode: "combine",
      combineBy: "fields",
      joinField: "customer",
      joinMode: "left",
    }),
    node("renamed", "core.data.renameKeys", {
      renames: [
        { from: "sum_lineTotal", to: "revenue" },
        { from: "count_lineTotal", to: "lineCount" },
      ],
    }),
    node("ranked", "core.data.sort", {
      sortFields: [{ field: "revenue", direction: "desc" }],
    }),
    node(
      "segmented",
      "core.loop.foreach",
      { itemPort: "item", resultPort: "result" },
      { loop: { body: segmentBody } }
    ),
    node("top", "core.data.limit", { maxItems: 2 }),
    node("csv", "core.io.convertToFile", {
      operation: "csv",
      fileName: "order-analytics.csv",
    }),
    node("write", "core.io.writeBinaryFile", {
      fileName: "var/as-graph-demo/order-analytics.csv",
    }),
    node("read", "core.io.readBinaryFile", {}),
    node("parsed", "core.io.extractFromFile", { format: "csv" }),
    node("roundTrip", "core.data.compareDatasets", {
      fieldsToMatch: [{ field1: "customer", field2: "customer" }],
      fuzzyCompare: true,
    }),
  ],
  edges: [
    edge("e1", ["workflow", "orders"], ["node", "lines", "value"]),
    edge("e2", ["node", "lines", "result"], ["node", "priced", "data"]),
    edge("e3", ["node", "priced", "result"], ["node", "billable", "value"]),
    edge("e4", ["node", "billable", "result"], ["node", "perCustomer", "value"]),
    edge("e5", ["node", "perCustomer", "result"], ["node", "enriched", "input"]),
    edge("e6", ["workflow", "customers"], ["node", "enriched", "input2"]),
    edge("e7", ["node", "enriched", "result"], ["node", "renamed", "value"]),
    edge("e8", ["node", "renamed", "result"], ["node", "ranked", "value"]),
    edge("e9", ["node", "ranked", "result"], ["node", "segmented", "items"]),
    edge("e10", ["node", "segmented", "completed"], ["node", "top", "value"]),
    edge("e11", ["node", "top", "result"], ["node", "csv", "value"]),
    edge("e12", ["node", "csv", "result"], ["node", "write", "value"]),
    // The written file's path drives the reader: a wired configuration port.
    edge("e13", ["node", "write", "result"], ["node", "read", "value"]),
    edge("e14", ["node", "read", "result"], ["node", "parsed", "value"]),
    edge("e15", ["node", "top", "result"], ["node", "roundTrip", "input"]),
    edge("e16", ["node", "parsed", "result"], ["node", "roundTrip", "input2"]),
    edge("e17", ["node", "top", "result"], ["workflow", "report"]),
    edge("e18", ["node", "read", "result"], ["workflow", "file"]),
    edge("e19", ["node", "roundTrip", "same"], ["workflow", "roundTripSame"]),
    edge(
      "e20",
      ["node", "roundTrip", "different"],
      ["workflow", "roundTripDifferent"]
    ),
  ],
});

/** Demo inputs: three orders across three customers, one zero-value line. */
export const ORDER_ANALYTICS_INPUTS = {
  orders: [
    {
      id: "o-1",
      customer: "acme",
      lines: [
        { sku: "bolt", qty: 10, price: 2.5 },
        { sku: "nut", qty: 100, price: 1 },
      ],
    },
    {
      id: "o-2",
      customer: "globex",
      lines: [
        { sku: "bolt", qty: 4, price: 2.5 },
        { sku: "sample", qty: 1, price: 0 },
      ],
    },
    {
      id: "o-3",
      customer: "initech",
      lines: [{ sku: "gear", qty: 3, price: 20 }],
    },
  ],
  customers: [
    { customer: "acme", tier: "gold" },
    { customer: "globex", tier: "silver" },
    { customer: "initech", tier: "bronze" },
  ],
};

/** The report the pipeline must produce for {@link ORDER_ANALYTICS_INPUTS}. */
export const ORDER_ANALYTICS_REPORT = [
  {
    customer: "acme",
    revenue: 125,
    lineCount: 2,
    tier: "gold",
    segment: "key",
  },
  {
    customer: "initech",
    revenue: 60,
    lineCount: 1,
    tier: "bronze",
    segment: "standard",
  },
];

/** Fixture descriptor for the order-analytics demo. */
export const orderAnalyticsFixture: GraphWorkflowFixture = {
  id: orderAnalyticsDocument.id,
  document: orderAnalyticsDocument,
  kinds: [
    "core.data.splitOut",
    "core.utility.code",
    "core.data.filter",
    "core.data.summarize",
    "core.data.merge",
    "core.data.renameKeys",
    "core.data.sort",
    "core.loop.foreach",
    "core.flow.if",
    "core.data.set",
    "core.data.limit",
    "core.io.convertToFile",
    "core.io.writeBinaryFile",
    "core.io.readBinaryFile",
    "core.io.extractFromFile",
    "core.data.compareDatasets",
  ],
  combos: ["straight-value", "exposed-ports", "user-controlled-properties"],
  executable: true,
  inputs: ORDER_ANALYTICS_INPUTS,
  expectedOutputs: { report: ORDER_ANALYTICS_REPORT },
};
