/**
 * @module as-graph/tests/unit/graph/nodes/GeneralEngineNodeManifests.test
 * @summary Manifest and catalogue assertions for the SAA-746 Stage 1 kinds.
 * @description Asserts the exact kind ids, display categories, required input
 * and output ports, built-in catalogue registration, and the `data`/`io` (plus
 * flow-control/trigger) i18n category keys for all sixteen general-engine node
 * kinds added by the Stage 1 port.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND,
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
} from "../../../../src/node";
import type { GraphNodeClass } from "../../../../src/node/base";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { SetNode } from "../../../../src/node/data/set/node";
import { MergeNode } from "../../../../src/node/data/merge/node";
import { FilterNode } from "../../../../src/node/data/filter/node";
import { SplitOutNode } from "../../../../src/node/data/split-out/node";
import { DateTimeNode } from "../../../../src/node/data/date-time/node";
import { DataTableNode } from "../../../../src/node/data/data-table/node";
import { LimitNode } from "../../../../src/node/data/limit/node";
import { SortNode } from "../../../../src/node/data/sort/node";
import { RenameKeysNode } from "../../../../src/node/data/rename-keys/node";
import { HttpRequestNode } from "../../../../src/node/io/http-request/node";
import { RespondToWebhookNode } from "../../../../src/node/io/respond-to-webhook/node";
import { ExtractFromFileNode } from "../../../../src/node/io/extract-from-file/node";
import { ReadPDFNode } from "../../../../src/node/io/read-pdf/node";
import { ReadWriteFileNode } from "../../../../src/node/io/read-write-file/node";
import { ExecuteSubWorkflowNode } from "../../../../src/node/flow/execute-sub-workflow/node";
import { ExecuteWorkflowTriggerNode } from "../../../../src/node/triggers/execute-workflow/node";
import { registerBuiltInGraphNodes } from "../../../../src/engine/catalog/GraphBuiltInRegistrations";
import { GraphWorkflowDocumentValidator } from "../../../../src/engine/validation/GraphWorkflowDocumentValidator";
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import { documentEdge, documentNode, documentPort, freshCatalogue } from "../engine-fixtures";

interface KindCase {
  nodeClass: GraphNodeClass;
  kind: string;
  category: "Data" | "IO" | "Flow Control" | "Trigger";
  inputs: string[];
  outputs: string[];
  i18n: [string, string];
}

const CASES: KindCase[] = [
  {
    nodeClass: SetNode,
    kind: "core.data.set",
    category: "Data",
    inputs: ["value", "assignments", "includeOtherFields", "dotNotation"],
    outputs: ["result"],
    i18n: ["data", "set"],
  },
  {
    nodeClass: MergeNode,
    kind: "core.data.merge",
    category: "Data",
    inputs: [
      "input",
      "input2",
      "mode",
      "combineBy",
      "joinMode",
      "joinField",
      "clashHandling",
    ],
    outputs: ["result"],
    i18n: ["data", "merge"],
  },
  {
    nodeClass: FilterNode,
    kind: "core.data.filter",
    category: "Data",
    inputs: ["value", "condition", "negate"],
    outputs: ["result"],
    i18n: ["data", "filter"],
  },
  {
    nodeClass: SplitOutNode,
    kind: "core.data.splitOut",
    category: "Data",
    inputs: ["value", "field", "include", "destinationField"],
    outputs: ["result"],
    i18n: ["data", "split_out"],
  },
  {
    nodeClass: DateTimeNode,
    kind: "core.data.dateTime",
    category: "Data",
    inputs: ["value", "operation", "format", "amount", "unit"],
    outputs: ["result", "iso", "timestamp"],
    i18n: ["data", "date_time"],
  },
  {
    nodeClass: DataTableNode,
    kind: "core.data.dataTable",
    category: "Data",
    inputs: ["value", "operation", "tableName", "rowId", "rowIdField", "row", "limit"],
    outputs: ["result", "count"],
    i18n: ["data", "data_table"],
  },
  {
    nodeClass: LimitNode,
    kind: "core.data.limit",
    category: "Data",
    inputs: ["value", "maxItems", "keep"],
    outputs: ["result"],
    i18n: ["data", "limit"],
  },
  {
    nodeClass: SortNode,
    kind: "core.data.sort",
    category: "Data",
    inputs: ["value", "sortFields", "valueType", "dotNotation"],
    outputs: ["result"],
    i18n: ["data", "sort"],
  },
  {
    nodeClass: RenameKeysNode,
    kind: "core.data.renameKeys",
    category: "Data",
    inputs: ["value", "renames", "dotNotation"],
    outputs: ["result"],
    i18n: ["data", "rename_keys"],
  },
  {
    nodeClass: HttpRequestNode,
    kind: "core.io.httpRequest",
    category: "IO",
    inputs: [
      "value",
      "url",
      "method",
      "headers",
      "query",
      "body",
      "responseFormat",
      "timeoutMs",
      "failOnError",
    ],
    outputs: ["result", "status", "headers"],
    i18n: ["io", "http_request"],
  },
  {
    nodeClass: RespondToWebhookNode,
    kind: "core.io.respondToWebhook",
    category: "IO",
    inputs: ["value", "respondWith", "responseCode", "responseHeaders", "responseBody"],
    outputs: ["response", "delivered"],
    i18n: ["io", "respond_to_webhook"],
  },
  {
    nodeClass: ExtractFromFileNode,
    kind: "core.io.extractFromFile",
    category: "IO",
    inputs: ["value", "format", "encoding", "delimiter", "headerRow"],
    outputs: ["result", "rows"],
    i18n: ["io", "extract_from_file"],
  },
  {
    nodeClass: ReadPDFNode,
    kind: "core.io.readPDF",
    category: "IO",
    inputs: ["value", "encoding", "password"],
    outputs: ["result", "pages"],
    i18n: ["io", "read_pdf"],
  },
  {
    nodeClass: ReadWriteFileNode,
    kind: "core.io.readWriteFile",
    category: "IO",
    inputs: [
      "value",
      "operation",
      "path",
      "encoding",
      "content",
      "append",
      "createDirectories",
    ],
    outputs: ["result", "bytes"],
    i18n: ["io", "read_write_file"],
  },
  {
    nodeClass: ExecuteSubWorkflowNode,
    kind: "core.flow.executeSubWorkflow",
    category: "Flow Control",
    inputs: ["value", "workflowId", "workflow", "mode", "inputPort"],
    outputs: ["result", "outputs", "childRunId"],
    i18n: ["flow_control", "execute_sub_workflow"],
  },
  {
    nodeClass: ExecuteWorkflowTriggerNode,
    kind: "core.trigger.executeWorkflow",
    category: "Trigger",
    inputs: ["payload", "schema"],
    outputs: ["result"],
    i18n: ["trigger", "execute_workflow"],
  },
];

interface D2Case {
  kind: string;
  output: string;
  parameters: Record<string, unknown>;
  expected: Record<string, "collection" | "object">;
}

/**
 * The SAA-946 D2 structured parameters: their natural JSON value and the
 * manifest type the canonical-document gate must accept it as.
 */
const D2_CASES: D2Case[] = [
  {
    kind: "core.data.set",
    output: "result",
    parameters: {
      value: { a: 1 },
      assignments: [{ name: "b", value: 2 }],
    },
    expected: { assignments: "collection" },
  },
  {
    kind: "core.data.sort",
    output: "result",
    parameters: {
      value: { items: [{ n: 2 }, { n: 1 }] },
      sortFields: [{ field: "n", direction: "asc" }],
    },
    expected: { sortFields: "collection" },
  },
  {
    kind: "core.data.renameKeys",
    output: "result",
    parameters: {
      value: { old: 1 },
      renames: [{ from: "old", to: "new" }],
    },
    expected: { renames: "collection" },
  },
  {
    kind: "core.data.dataTable",
    output: "result",
    parameters: {
      operation: "insert",
      tableName: "d2_table",
      row: { id: "row-1", value: "x" },
    },
    expected: { row: "object" },
  },
  {
    kind: "core.io.httpRequest",
    output: "result",
    parameters: {
      url: "http://localhost/",
      headers: { "x-test": "1" },
      query: { q: "search" },
      body: { payload: true },
    },
    expected: { headers: "object", query: "object", body: "object" },
  },
  {
    kind: "core.io.respondToWebhook",
    output: "response",
    parameters: {
      respondWith: "json",
      responseHeaders: { "x-test": "1" },
      responseBody: { ok: true },
    },
    expected: { responseHeaders: "object", responseBody: "object" },
  },
  {
    kind: "core.flow.executeSubWorkflow",
    output: "result",
    parameters: {
      workflow: {
        id: "child-wf",
        name: "child-wf",
        inputs: [],
        outputs: [],
        nodes: [],
        edges: [],
      },
    },
    expected: { workflow: "object" },
  },
  {
    kind: "core.trigger.executeWorkflow",
    output: "result",
    parameters: {
      schema: { type: "object", properties: { value: { type: "string" } } },
    },
    expected: { schema: "object" },
  },
];

interface I18nNodeSection {
  name?: string;
  description?: string;
}

const i18n = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../assets/i18n/en.json"), "utf8")
) as {
  graph: {
    node: {
      categories: Record<string, string>;
      [category: string]: Record<string, I18nNodeSection> | Record<string, string>;
    };
  };
};

describe("SAA-746 Stage 1 general-engine node manifests", () => {
  it.each(CASES)("publishes $kind with category $category and its ports", (entry) => {
    const manifest = graphNodeManifest(entry.nodeClass);

    expect(manifest.kind).toBe(entry.kind);
    expect(manifest.display.category).toBe(entry.category);
    expect(manifest.inputs.map((port) => port.id)).toEqual(entry.inputs);
    expect(manifest.outputs.map((port) => port.id)).toEqual(entry.outputs);
    expect(manifest.inputs.every((port) => port.direction === "input")).toBe(true);
    expect(manifest.outputs.every((port) => port.direction === "output")).toBe(true);
  });

  it.each(CASES)("registers $kind in the built-in catalogue maps", (entry) => {
    expect(GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND[entry.kind]).toBe(entry.nodeClass);
    const registered = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[entry.kind];
    expect(registered.kind).toBe(entry.kind);
    expect(registered.display.category).toBe(entry.category);
    expect(registered.inputs.map((port) => port.id)).toEqual(entry.inputs);
    expect(registered.outputs.map((port) => port.id)).toEqual(entry.outputs);
  });

  it.each(CASES)("has an i18n name/description section for $kind", (entry) => {
    const [category, section] = entry.i18n;
    const sectionValue = i18n.graph.node[category]?.[section] as
      | I18nNodeSection
      | undefined;
    expect(sectionValue).toBeDefined();
    expect(typeof sectionValue?.name).toBe("string");
    expect(sectionValue?.name?.length).toBeGreaterThan(0);
    expect(typeof sectionValue?.description).toBe("string");
    expect(sectionValue?.description?.length).toBeGreaterThan(0);
  });

  it("publishes the data/io/flow-control/trigger i18n category keys", () => {
    expect(i18n.graph.node.categories).toMatchObject({
      data: "Data",
      io: "IO",
      flow_control: "Flow Control",
      trigger: "Trigger",
    });
  });

  it("covers exactly the sixteen Stage 1 kinds", () => {
    expect(CASES).toHaveLength(16);
    expect(new Set(CASES.map((entry) => entry.kind)).size).toBe(16);
  });
});

describe("SAA-946 D2 structured parameter manifest types", () => {
  it.each(D2_CASES)(
    "declares the structured manifest types for $kind",
    (entry) => {
      const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[entry.kind];
      for (const [id, expectedType] of Object.entries(entry.expected)) {
        const parameter = manifest.parameters.find(
          (candidate) => candidate.id === id
        );
        expect(parameter).toBeDefined();
        expect(parameter?.type).toBe(expectedType);
      }
    }
  );

  it.each(D2_CASES)(
    "accepts the natural structured values for $kind on the canonical-document path",
    async (entry) => {
      const catalogue = freshCatalogue();
      await registerBuiltInGraphNodes(catalogue);
      const validator = new GraphWorkflowDocumentValidator({ catalogue });
      const document: GraphWorkflowDocument = {
        id: `d2-${entry.kind}`,
        name: `d2-${entry.kind}`,
        inputs: [],
        outputs: [documentPort("result")],
        nodes: [documentNode("node", entry.kind, entry.parameters)],
        edges: [
          documentEdge(
            "e-out",
            ["node", "node", entry.output],
            ["workflow", "result"]
          ),
        ],
      };

      const result = await validator.validate(document);
      const typeMismatches = result.issues.filter(
        (issue) => issue.code === "parameter.type-mismatch"
      );
      expect(typeMismatches).toEqual([]);
      expect(result.valid).toBe(true);
    }
  );
});
