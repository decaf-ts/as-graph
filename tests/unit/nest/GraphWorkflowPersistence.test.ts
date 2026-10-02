/**
 * @module as-graph/tests/unit/nest/GraphWorkflowPersistence.test
 * @summary DECAF-50 §4.19 nest-row persistence slice + §4.20 P7 cutover
 * regression tests: saveDocument/getDocument round trip,
 * validate-before-persist, ownership, forbidden fields, duplicate ids,
 * document limits, UI-state preservation, legacy-snapshot rejection
 * (wrapper-only saveSnapshot, persisted-legacy read-path rejection with no
 * conversion) and structured GraphValidationIssue shape.
 */
import { describe, beforeAll, it, expect } from "@jest/globals";
import { Context, ForbiddenError, PersistenceService } from "@decaf-ts/core";
import { NotFoundError, ValidationError } from "@decaf-ts/db-decorators";
import { RamAdapter } from "@decaf-ts/core/ram";
import {
  GraphWorkflowDocumentBuilder,
  type GraphWorkflowDocument,
} from "../../../src/shared/graph";
import { GraphWorkflowService } from "../../../src/engine/services/GraphWorkflowService";
import { GraphEnvironment } from "../../../src/engine/services/GraphEnvironment";
import { GraphWorkflowModel } from "../../../src/shared/graph/GraphWorkflowModel";
import { GraphWorkflowDocumentRejectedError } from "../../../src/engine/errors/GraphWorkflowErrors";
import { validateGraphWorkflowDocumentAtBoundary } from "../../../src/engine/validation/GraphWorkflowBoundaryValidation";
import type { GraphValidationIssue } from "../../../src";
import {
  documentEdge,
  documentNode,
  documentPort,
} from "../graph/engine-fixtures";

RamAdapter.decoration();

function userContext(user: string): Context {
  const ctx = new Context();
  return ctx.accumulate({ user, timestamp: new Date() } as object) as Context;
}

function wireDocument(workflowId: string): GraphWorkflowDocument {
  const built = new GraphWorkflowDocumentBuilder(workflowId, `Doc ${workflowId}`)
    .addInput({ id: "brief", schema: { type: "string" }, defaultValue: "b" })
    .addOutput({ id: "summary", schema: { type: "string" } })
    .addNode({
      id: "n1",
      kind: "core.transform",
      parameters: { value: "start" },
      ui: { position: { x: 1, y: 2 }, size: { width: 100, height: 40 } },
    })
    .addEdge({
      id: "re0",
      type: "data",
      source: { scope: "workflow", port: "brief" },
      target: { scope: "node", nodeId: "n1", port: "value" },
    })
    .addEdge({
      id: "re1",
      type: "connection",
      source: { scope: "node", nodeId: "n1", port: "modelRes" },
      target: { scope: "workflow", port: "summary" },
    })
    .build();
  return JSON.parse(JSON.stringify(built)) as GraphWorkflowDocument;
}

function legacySnapshot(): Record<string, unknown> {
  return {
    version: 1,
    definition: {
      name: "Legacy Workflow",
      tag: "legacy-wf",
      kind: "core.workflow.legacy",
      labels: ["legacy"],
      inputs: [{ property: "in1", label: "In One", type: "string" }],
      outputs: [{ property: "out1", label: "Out One" }],
      nodes: [{ id: "n1", kind: "core.transform" }],
      relations: [
        { id: "rel0", source: "$workflow", sourcePort: "in1", target: "n1", targetPort: "value" },
        { id: "rel1", source: "legacy-wf", sourcePort: "out1", target: "n1", targetPort: "value" },
      ],
    },
    state: {
      inputs: [{ path: "in1", value: "seed" }],
      outputs: [{ path: "out1", value: null }],
      nodes: [
        {
          id: "n1",
          kind: "core.transform",
          label: "Transform",
          position: { x: 10, y: 20 },
          ports: {
            value: { mode: "port" },
            factor: { mode: "value", value: 3 },
          },
          data: { keep: "yes" },
          metadata: { stage: 1 },
        },
      ],
      edges: [
        { id: "e1", source: "$workflow", sourcePort: "in1", target: "n1", targetPort: "value", label: "seed" },
        { id: "e2", source: "workflow", sourcePort: "in1", target: "n1", targetPort: "factor" },
        { id: "e3", source: "graph", sourcePort: "in1", target: "legacy-wf", targetPort: "out1" },
      ],
      ui: {
        duplicateCounts: { n1: 2 },
        diagramMetadata: { viewport: { x: 5, y: 6, scale: 0.8 } },
      },
      metadata: { team: "core" },
    },
  };
}

function expectStructuredIssues(issues: GraphValidationIssue[]): void {
  expect(issues.length).toBeGreaterThan(0);
  for (const issue of issues) {
    expect(typeof issue.code).toBe("string");
    expect(issue.code.length).toBeGreaterThan(0);
    expect(typeof issue.path).toBe("string");
    expect(issue.path.length).toBeGreaterThan(0);
    expect(typeof issue.message).toBe("string");
    expect(issue.message.length).toBeGreaterThan(0);
    if (issue.details !== undefined) {
      for (const [key, value] of Object.entries(issue.details)) {
        expect(["__proto__", "prototype", "constructor"]).not.toContain(key);
        expect(
          value === null ||
            ["string", "number", "boolean"].includes(typeof value)
        ).toBe(true);
      }
    }
  }
}

async function expectRejectsWith<T extends Error>(
  promise: Promise<unknown>,
  ctor: new (...args: never[]) => T
): Promise<T> {
  let caught: unknown;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (e) {
    caught = e;
  }
  expect(resolved).toBe(false);
  expect(caught).toBeInstanceOf(ctor);
  expect((caught as Error).constructor.name).toBe(ctor.name);
  return caught as T;
}

async function rejectionIssuesOf(
  promise: Promise<unknown>
): Promise<GraphValidationIssue[]> {
  const caught = await expectRejectsWith(
    promise,
    GraphWorkflowDocumentRejectedError as unknown as new (
      ...args: never[]
    ) => GraphWorkflowDocumentRejectedError
  );
  const issues = caught.issues;
  expect(Array.isArray(issues)).toBe(true);
  expectStructuredIssues(issues);
  return issues;
}

function issueByCode(
  issues: GraphValidationIssue[],
  code: string
): GraphValidationIssue[] {
  return issues.filter((issue) => issue.code === code);
}

describe("GraphWorkflowPersistence (§4.19 nest row)", () => {
  let service: GraphWorkflowService;

  beforeAll(async () => {
    const persistence = new PersistenceService();
    await persistence.boot([[RamAdapter, { UUID: "root" }]] as never);
    // SAA-595: the §4.15 anonymous-on-owned tolerance this suite pins (test 4)
    // is now an explicit opt-in; secure defaults fail closed. Services read
    // their options from the graph environment (`@decaf-ts/logging`), not from
    // injectable config objects.
    GraphEnvironment.accumulate({
      graph: { workflows: { allowAnonymousAccess: true } },
    } as never);
    service = new GraphWorkflowService();
  });

  it("1. saveDocument → getDocument semantic round trip; updatedAt set; workflowId is the primary key", async () => {
    const doc = wireDocument("rt-1");
    const anonymous = new Context();
    const saved = await service.saveDocument("rt-1", doc, anonymous);
    expect(saved.workflowId).toBe("rt-1");
    expect(saved.updatedAt).toBeInstanceOf(Date);
    const loaded = await service.getDocument("rt-1", anonymous);
    expect(loaded).toEqual(doc);
    expect(loaded.id).toBe("rt-1");
  });

  it("2. validate-before-persist: an invalid document raises ValidationError and nothing is persisted", async () => {
    const invalid = {
      id: "inv-1",
      name: 42,
      inputs: [],
      outputs: [],
      nodes: [],
      edges: [],
    } as unknown as GraphWorkflowDocument;
    await expectRejectsWith(
      service.saveDocument("inv-1", invalid, new Context()),
      ValidationError as unknown as new (...args: never[]) => ValidationError
    );
    await expectRejectsWith(
      service.getDocument("inv-1", new Context()),
      NotFoundError as unknown as new (...args: never[]) => NotFoundError
    );
  });

  it("3. path/document-id mismatch → ValidationError and nothing is persisted", async () => {
    const doc = wireDocument("mm-doc");
    await expectRejectsWith(
      service.saveDocument("mm-1", doc, new Context()),
      ValidationError as unknown as new (...args: never[]) => ValidationError
    );
    await expectRejectsWith(
      service.getDocument("mm-1", new Context()),
      NotFoundError as unknown as new (...args: never[]) => NotFoundError
    );
  });

  it("4. ownership: cross-owner access → ForbiddenError; owner-less/anonymous callers tolerated", async () => {
    const doc = wireDocument("own-1");
    const alice = userContext("alice");
    const bob = userContext("bob");
    const saved = await service.saveDocument("own-1", doc, alice);
    expect(saved.owner).toBe("alice");
    await expectRejectsWith(
      service.getDocument("own-1", bob),
      ForbiddenError as unknown as new (...args: never[]) => ForbiddenError
    );
    await expectRejectsWith(
      service.saveDocument("own-1", doc, bob),
      ForbiddenError as unknown as new (...args: never[]) => ForbiddenError
    );
    expect(await service.getDocument("own-1", alice)).toEqual(doc);
    expect(await service.getDocument("own-1", new Context())).toEqual(doc);
  });

  it("5. forbidden fields (node/definition/executor/execute/ports/component, incl. loop bodies) → structured issues, nothing persisted", async () => {
    const doc = wireDocument("ff-1");
    (doc as Record<string, unknown>).definition = { kind: "core.workflow.legacy" };
    (doc.nodes[0] as Record<string, unknown>).executor = { command: "echo" };
    (doc.edges[0] as Record<string, unknown>).ports = { value: {} };
    (doc.inputs[0] as Record<string, unknown>).component = { template: "<x/>" };
    const issues = await rejectionIssuesOf(
      service.saveDocument("ff-1", doc, new Context())
    );
    const forbidden = issueByCode(issues, "document.forbidden-field");
    const paths = forbidden.map((issue) => issue.path);
    expect(paths).toContain("$.definition");
    expect(paths).toContain("nodes[n1].executor");
    expect(paths).toContain("edges[re0].ports");
    expect(paths).toContain("inputs[0].component");
    for (const issue of forbidden) {
      expect(issue.details?.field).toBeDefined();
    }
    await expectRejectsWith(
      service.getDocument("ff-1", new Context()),
      NotFoundError as unknown as new (...args: never[]) => NotFoundError
    );

    const loopDoc = wireDocument("ff-loop");
    const loopBody = wireDocument("ff-loop");
    (loopBody as Record<string, unknown>).component = { template: "<loop/>" };
    (loopDoc.nodes[0] as Record<string, unknown>).loop = { body: loopBody };
    const loopIssues = issueByCode(
      (await validateGraphWorkflowDocumentAtBoundary(loopDoc)).issues,
      "document.forbidden-field"
    );
    expect(loopIssues.length).toBeGreaterThan(0);
    expect(loopIssues.map((issue) => issue.path)).toContain("$.component");
  });

  it("6. duplicate node/edge/port ids → structured issues with code/path/nodeId|edgeId populated", async () => {
    const doc = wireDocument("dup-1");
    doc.nodes.push({ ...doc.nodes[0] });
    doc.edges.push({ ...doc.edges[0] });
    doc.inputs.push({ ...doc.inputs[0] });
    const issues = await rejectionIssuesOf(
      service.saveDocument("dup-1", doc, new Context())
    );
    const nodeIssues = issueByCode(issues, "document.duplicate-node-id");
    expect(nodeIssues.length).toBe(1);
    expect(nodeIssues[0].path).toBe("nodes[n1]");
    expect(nodeIssues[0].nodeId).toBe("n1");
    const edgeIssues = issueByCode(issues, "document.duplicate-edge-id");
    expect(edgeIssues.length).toBe(1);
    expect(edgeIssues[0].path).toBe("edges[re0]");
    expect(edgeIssues[0].edgeId).toBe("re0");
    const portIssues = issueByCode(issues, "document.duplicate-port-id");
    expect(portIssues.length).toBe(1);
    expect(portIssues[0].path).toBe("ports[brief]");
    await expectRejectsWith(
      service.getDocument("dup-1", new Context()),
      NotFoundError as unknown as new (...args: never[]) => NotFoundError
    );
  });

  it("7. GraphWorkflowDocumentLimits enforced: over-limit documents rejected with structured issues; overrides respected", async () => {
    const tooManyNodes = wireDocument("lim-nodes");
    const nodes = [...tooManyNodes.nodes];
    for (let i = 0; i < 500; i += 1) {
      nodes.push({ ...tooManyNodes.nodes[0], id: `extra-${i}` });
    }
    tooManyNodes.nodes = nodes;
    const nodeIssues = await rejectionIssuesOf(
      service.saveDocument("lim-nodes", tooManyNodes, new Context())
    );
    const nodeLimit = issueByCode(nodeIssues, "document.limit.nodes");
    expect(nodeLimit.length).toBe(1);
    expect(nodeLimit[0].path).toBe("$.nodes");
    expect(nodeLimit[0].details).toEqual({ count: 501, limit: 500 });

    const tooManyEdges = wireDocument("lim-edges");
    const edges = [...tooManyEdges.edges];
    for (let i = 0; i < 1000; i += 1) {
      edges.push({ ...tooManyEdges.edges[0], id: `extra-${i}` });
    }
    tooManyEdges.edges = edges;
    const edgeIssues = await rejectionIssuesOf(
      service.saveDocument("lim-edges", tooManyEdges, new Context())
    );
    const edgeLimit = issueByCode(edgeIssues, "document.limit.edges");
    expect(edgeLimit.length).toBe(1);
    expect(edgeLimit[0].path).toBe("$.edges");
    expect(edgeLimit[0].details).toEqual({ count: 1002, limit: 1000 });

    // Limits overrides (GRAPH_WORKFLOW_OPTIONS → GraphWorkflowServiceOptions.limits)
    // cannot be exercised through a second in-process service instance: the
    // @service injectables registry keeps the first-instantiated service
    // (default limits, created in beforeAll) and shadows later constructor
    // arguments and Nest DI options (documented by GraphWorkflowServiceProbe).
    // The override is therefore asserted on the boundary validator the service
    // delegates to, which merges options.limits over the defaults the same way
    // the service constructor does.
    const overridden = await validateGraphWorkflowDocumentAtBoundary(
      wireDocument("lim-strict"),
      { limits: { maxNodes: 0 } }
    );
    expect(overridden.valid).toBe(false);
    const strictLimit = issueByCode(overridden.issues, "document.limit.nodes");
    expect(strictLimit.length).toBe(1);
    expect(strictLimit[0].details).toEqual({ count: 1, limit: 0 });
  });
  it("8. UI state is preserved through the save/load round trip", async () => {
    const doc = wireDocument("ui-1");
    doc.ui = { viewport: { x: 11, y: 22, zoom: 0.9 } };
    doc.metadata = { team: "qa" };
    doc.nodes[0].ui = { position: { x: 7, y: 8 }, size: { width: 120, height: 60 } };
    await service.saveDocument("ui-1", doc, new Context());
    const loaded = await service.getDocument("ui-1", new Context());
    expect(loaded).toEqual(doc);
    expect(loaded.ui).toEqual({ viewport: { x: 11, y: 22, zoom: 0.9 } });
    expect(loaded.nodes[0].ui).toEqual({
      position: { x: 7, y: 8 },
      size: { width: 120, height: 60 },
    });
  });

  it("9. P7 cutover regression (§4.11/§4.18/§4.26 R2-2): legacy non-wrapper snapshot payloads are rejected with ValidationError; canonical wrapper snapshots round-trip; getDocument prefers document; already-persisted legacy snapshots are rejected on read with no conversion", async () => {
    const anonymous = new Context();

    // 9a. Legacy definition/state snapshot payloads are REJECTED by default
    // (flag-independent): the message names canonical wrappers and the
    // canonical document API, and nothing is persisted.
    const legacy = legacySnapshot();
    const rejection = await expectRejectsWith(
      service.saveSnapshot("legacy-wf", legacy, anonymous),
      ValidationError as unknown as new (...args: never[]) => ValidationError
    );
    expect(rejection.message).toMatch(/canonical GraphWorkflowDocument/);
    expect(rejection.message).toMatch(/PUT \/graph\/workflows\//);
    expect(await service.loadSnapshot("legacy-wf", anonymous)).toBeNull();

    // 9b. JSON-unsafe payloads are still rejected by the JSON-safe gate.
    await expectRejectsWith(
      service.saveSnapshot(
        "legacy-unsafe",
        { version: 1, definition: { run: () => undefined } },
        anonymous
      ),
      ValidationError as unknown as new (...args: never[]) => ValidationError
    );
    expect(await service.loadSnapshot("legacy-unsafe", anonymous)).toBeNull();

    // 9c. Canonical wrapper snapshots ({ document, editor?, metadata? })
    // round-trip: the snapshot column keeps the wrapper, the document column
    // keeps the canonical document, and reads prefer the document.
    const doc = wireDocument("legacy-wf");
    const wrapper = {
      document: doc,
      editor: { viewport: { x: 1, y: 2, zoom: 0.9 } },
      metadata: { team: "qa" },
    };
    const saved = await service.saveSnapshot("legacy-wf", wrapper, anonymous);
    expect(saved.snapshot).toEqual(wrapper);
    expect(saved.document).toEqual(doc);
    const model = await service.loadSnapshot("legacy-wf", anonymous);
    expect(model?.snapshot).toEqual(wrapper);
    expect(model?.document).toEqual(doc);
    expect(await service.getDocument("legacy-wf", anonymous)).toEqual(doc);

    // 9d. Read-path conversion of ALREADY-PERSISTED legacy snapshots is
    // GONE (DECAF-50 §4.26 R2-2): models persisted before the cutover
    // (directly, not through saveSnapshot) no longer convert on read —
    // getDocument throws NotFoundError and never fabricates a document from a
    // legacy definition/state payload.
    const persistedLegacy = legacySnapshot();
    await service.create(
      new GraphWorkflowModel({
        workflowId: "legacy-read",
        snapshot: persistedLegacy,
      }),
      anonymous
    );
    const readRejection = await expectRejectsWith(
      service.getDocument("legacy-read", anonymous),
      NotFoundError as unknown as new (...args: never[]) => NotFoundError
    );
    expect(readRejection.message).toMatch(/legacy definition\/state snapshots are no longer supported/);
    // the legacy snapshot row itself is untouched
    const legacyModel = await service.read("legacy-read", anonymous);
    expect((legacyModel as GraphWorkflowModel).snapshot).toEqual(persistedLegacy);
  });

  it("9b. P7 cutover regression: no dual-write — a legacy saveSnapshot after a canonical save is rejected and the canonical document stays authoritative; wrapper snapshots update the document column", async () => {
    const canonical = wireDocument("pin-dw");
    const anonymous = new Context();
    await service.saveDocument("pin-dw", canonical, anonymous);

    // The §4.18 transition dual-write is gone: legacy snapshot saves are
    // rejected outright and cannot leave the document column stale.
    await expectRejectsWith(
      service.saveSnapshot("pin-dw", legacySnapshot(), anonymous),
      ValidationError as unknown as new (...args: never[]) => ValidationError
    );
    expect(await service.getDocument("pin-dw", anonymous)).toEqual(canonical);

    // A canonical wrapper snapshot save updates the document column; reads
    // still prefer the document.
    const updated = wireDocument("pin-dw");
    updated.metadata = { team: "qa" };
    const wrapper = { document: updated };
    await service.saveSnapshot("pin-dw", wrapper, anonymous);
    expect(await service.getDocument("pin-dw", anonymous)).toEqual(updated);
    const model = await service.loadSnapshot("pin-dw", anonymous);
    expect(model?.snapshot).toEqual(wrapper);
    expect(model?.document).toEqual(updated);
  });

  it("10. structured issue shape: every rejection returns serializable GraphValidationIssue records with safe details", async () => {
    const doc = wireDocument("shape-1");
    (doc as Record<string, unknown>).definition = { kind: "x" };
    doc.nodes.push({ ...doc.nodes[0] });
    const issues = await rejectionIssuesOf(
      service.saveDocument("shape-1", doc, new Context())
    );
    expectStructuredIssues(issues);
    expect(() => JSON.stringify(issues)).not.toThrow();
    const serialized = JSON.parse(JSON.stringify(issues)) as GraphValidationIssue[];
    expect(serialized.length).toBe(issues.length);
    for (const issue of issues) {
      if (issue.nodeId !== undefined) expect(typeof issue.nodeId).toBe("string");
      if (issue.edgeId !== undefined) expect(typeof issue.edgeId).toBe("string");
    }
  });

  it("10b. builder-invariant pin (SAA-515/SAA-517, aligned with ui-decorators document-builder): raw GraphWorkflowDocumentBuilder output is JSON-safe and passes the boundary gate; the JSON-cloned wire document is equivalent", async () => {
    const raw = new GraphWorkflowDocumentBuilder("pin-raw", "Raw Doc")
      .addInput({ id: "brief", schema: { type: "string" }, defaultValue: "b" })
      .addOutput({ id: "summary", schema: { type: "string" } })
      .addNode({
        id: "n1",
        kind: "core.transform",
        parameters: { value: "start" },
        ui: { position: { x: 1, y: 2 }, size: { width: 100, height: 40 } },
      })
      .addEdge({
        id: "re0",
        type: "data",
        source: { scope: "workflow", port: "brief" },
        target: { scope: "node", nodeId: "n1", port: "value" },
      })
      .build();
    // Raw builder output no longer emits undefined-valued setters, so it is
    // JSON-safe and passes the JSON-safe gate without a wire clone.
    const rawResult = await service.validateDocument(raw);
    expect(rawResult.valid).toBe(true);
    expect(issueByCode(rawResult.issues ?? [], "document.json-unsafe")).toEqual([]);
    const wire = JSON.parse(JSON.stringify(raw)) as GraphWorkflowDocument;
    const wireResult = await service.validateDocument(wire);
    expect(wireResult.valid).toBe(true);
    expect(wireResult.issues).toEqual([]);
    // Wire clone is semantically equivalent to the raw output.
    expect(wire).toEqual(raw);
  });

  it("11. UI-authored switch+log addition (parameters.switch + top-level cases) saves and reloads intact (DECAF-50 §4.26 R4-4)", async () => {
    const cases = [
      {
        id: "case-1",
        label: "Case 1",
        outputPort: "case_1",
        condition: {
          op: "eq",
          left: { path: "value" },
          right: { const: 1 },
        },
      },
    ];
    const doc: GraphWorkflowDocument = {
      id: "ui-switch",
      name: "ui-switch",
      inputs: [documentPort("count")],
      outputs: [documentPort("result")],
      nodes: [
        documentNode("sw", "core.flow.switch", {
          cases,
          hasDefault: true,
          switch: { cases, defaultPort: "default", hasDefault: true },
        }),
        documentNode("log", "core.flow.log"),
      ],
      edges: [
        documentEdge("e_in", ["workflow", "count"], ["node", "sw", "value"]),
        documentEdge("e_case", ["node", "sw", "case_1"], ["node", "log", "value"]),
        documentEdge("e_out", ["node", "log", "logged"], ["workflow", "result"]),
      ],
    };
    const anonymous = new Context();
    const saved = await service.saveDocument("ui-switch", doc, anonymous);
    expect(saved.workflowId).toBe("ui-switch");
    const loaded = await service.getDocument("ui-switch", anonymous);
    expect(loaded).toEqual(doc);
    expect(loaded.nodes.map((node) => node.kind)).toEqual([
      "core.flow.switch",
      "core.flow.log",
    ]);
    expect(loaded.edges.map((edge) => edge.id)).toEqual([
      "e_in",
      "e_case",
      "e_out",
    ]);
  });

  it("unknown workflowId on GET → NotFoundError", async () => {
    await expectRejectsWith(
      service.getDocument("missing-workflow", new Context()),
      NotFoundError as unknown as new (...args: never[]) => NotFoundError
    );
  });
});
