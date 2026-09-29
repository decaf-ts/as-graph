/**
 * DECAF-50/P1 evidence: canonical document validation rules. Only the builder
 * (or the deserializer) produces documents; every violation is a ValidationError.
 */
import { ValidationError } from "@decaf-ts/db-decorators";
import {
  assertGraphWorkflowDocumentValid,
  GraphWorkflowDocumentBuilder,
  isGraphJsonSafeValue,
} from "../../../src/shared/graph";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";

function minimalDocument(): GraphWorkflowDocument {
  return {
    id: "doc-1",
    name: "Doc One",
    inputs: [{ id: "in1", schema: { type: "string" }, required: true }],
    outputs: [{ id: "out1" }],
    nodes: [
      {
        id: "n1",
        kind: "core.transform",
        parameters: { value: "x" },
        inputBindings: { value: { mode: "edge" } },
        outputBindings: { result: { enabled: true } },
      },
    ],
    edges: [
      {
        id: "re0",
        type: "data",
        source: { scope: "workflow", port: "in1" },
        target: { scope: "node", nodeId: "n1", port: "value" },
      },
    ],
  };
}

function expectValidationError(build: () => unknown, match?: RegExp): void {
  try {
    build();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).code).toBe(422);
    if (match) expect((e as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected a ValidationError but nothing was thrown");
}

function findUndefinedOwnKeyPaths(value: unknown, path = "document"): string[] {
  if (value === null || typeof value !== "object") return [];
  const paths: string[] = [];
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) {
      paths.push(`${path}.${key}`);
    } else {
      paths.push(...findUndefinedOwnKeyPaths(child, `${path}.${key}`));
    }
  }
  return paths;
}

describe("document builder", () => {
  it("produces a canonical document with defaults applied", () => {
    const document = new GraphWorkflowDocumentBuilder("review", "Review")
      .addInput({ id: "brief", schema: { type: "string" } })
      .addOutput({ id: "summary" })
      .addNode({ id: "n1", kind: "core.transform", parameters: { a: 1 } })
      .addEdge({
        id: "re0",
        type: "data",
        source: { scope: "workflow", port: "brief" },
        target: { scope: "node", nodeId: "n1", port: "a" },
      })
      .setUi({ viewport: { x: 0, y: 0, zoom: 1 } })
      .setMetadata({ team: "core" })
      .setSettings({ retries: 2 })
      .build();
    expect(document.id).toBe("review");
    expect(document.name).toBe("Review");
    expect(document.nodes[0]).toEqual({
      id: "n1",
      kind: "core.transform",
      parameters: { a: 1 },
    });
    expect(document.ui).toEqual({ viewport: { x: 0, y: 0, zoom: 1 } });
    expect(document.metadata).toEqual({ team: "core" });
    expect(document.settings).toEqual({ retries: 2 });
    expect(document.inputs).toHaveLength(1);
    expect(document.outputs).toHaveLength(1);
  });

  it("requires a non-empty document id", () => {
    expectValidationError(
      () => new GraphWorkflowDocumentBuilder("", "Name").build(),
      /id.*non-empty/i
    );
  });

  it("requires a non-empty document name", () => {
    expectValidationError(
      () => new GraphWorkflowDocumentBuilder("doc", "").build(),
      /name.*non-empty/i
    );
    expectValidationError(() => new GraphWorkflowDocumentBuilder("doc").build(), /name/i);
  });

  it("requires every node to declare a non-empty kind", () => {
    expectValidationError(
      () =>
        new GraphWorkflowDocumentBuilder("doc", "Name")
          .addNode({ id: "n1", kind: "", parameters: {} })
          .build(),
      /non-empty string 'kind'/
    );
  });

  it("requires node parameters to be present (empty object allowed)", () => {
    const document = minimalDocument();
    delete (document.nodes[0] as { parameters?: unknown }).parameters;
    expectValidationError(
      () => assertGraphWorkflowDocumentValid(document),
      /parameters must be present/
    );
  });

  it("enforces unique node ids", () => {
    expectValidationError(
      () =>
        new GraphWorkflowDocumentBuilder("doc", "Name")
          .addNode({ id: "n1", kind: "core.transform", parameters: {} })
          .addNode({ id: "n1", kind: "core.storage", parameters: {} })
          .build(),
      /Node id 'n1'.*unique/
    );
  });

  it("enforces unique edge ids", () => {
    const edge = {
      id: "re0",
      type: "data" as const,
      source: { scope: "node" as const, nodeId: "n1", port: "a" },
      target: { scope: "node" as const, nodeId: "n1", port: "b" },
    };
    expectValidationError(
      () =>
        new GraphWorkflowDocumentBuilder("doc", "Name")
          .addNode({ id: "n1", kind: "core.transform", parameters: {} })
          .addEdge(edge)
          .addEdge(edge)
          .build(),
      /Edge id 're0'.*unique/
    );
  });

  it("enforces unique workflow port ids across inputs and outputs", () => {
    expectValidationError(
      () =>
        new GraphWorkflowDocumentBuilder("doc", "Name")
          .addInput({ id: "p1" })
          .addOutput({ id: "p1" })
          .build(),
      /declared more than once/
    );
  });

  it("rejects endpoints that are not tagged {scope} objects", () => {
    const document = minimalDocument();
    (document.edges[0].source as unknown) = "workflow";
    expectValidationError(
      () => assertGraphWorkflowDocumentValid(document),
      /source endpoint is not a valid GraphEndpoint/
    );
  });

  it("rejects endpoints with extra keys or missing port identifiers", () => {
    const document = minimalDocument();
    (document.edges[0].source as unknown) = { scope: "workflow", port: "in1", extra: 1 };
    expectValidationError(() => assertGraphWorkflowDocumentValid(document));

    const document2 = minimalDocument();
    (document2.edges[0].target as unknown) = { scope: "node", nodeId: "n1" };
    expectValidationError(() => assertGraphWorkflowDocumentValid(document2));

    const document3 = minimalDocument();
    (document3.edges[0].target as unknown) = { scope: "node", nodeId: "n1", port: "" };
    expectValidationError(() => assertGraphWorkflowDocumentValid(document3));
  });

  it("rejects edges referencing undeclared workflow ports or unknown nodes", () => {
    const document = minimalDocument();
    (document.edges[0].source as unknown) = { scope: "workflow", port: "ghost" };
    expectValidationError(
      () => assertGraphWorkflowDocumentValid(document),
      /not declared on the document/
    );

    const document2 = minimalDocument();
    (document2.edges[0].target as unknown) = { scope: "node", nodeId: "ghost", port: "value" };
    expectValidationError(
      () => assertGraphWorkflowDocumentValid(document2),
      /not part of the document/
    );
  });

  it("rejects edge types other than data and connection", () => {
    const document = minimalDocument();
    (document.edges[0] as unknown as Record<string, unknown>)["type"] = "event";
    expectValidationError(
      () => assertGraphWorkflowDocumentValid(document),
      /not a valid edge type/
    );
  });

  it("rejects invalid node input bindings and unsafe binding keys", () => {
    const document = minimalDocument();
    document.nodes[0].inputBindings = { value: { mode: "literal", value: () => 1 } as never };
    expectValidationError(() => assertGraphWorkflowDocumentValid(document), /GraphInputBinding/);

    const document2 = minimalDocument();
    const bindings: Record<string, unknown> = {};
    Object.defineProperty(bindings, "constructor", {
      value: { mode: "edge" },
      enumerable: true,
      configurable: true,
    });
    document2.nodes[0].inputBindings = bindings as never;
    expectValidationError(
      () => assertGraphWorkflowDocumentValid(document2),
      /unsafe prototype-pollutant key/
    );
  });

  it("rejects expression bindings without an expression body", () => {
    const document = minimalDocument();
    document.nodes[0].inputBindings = { value: { mode: "expression", expression: "" } };
    expectValidationError(
      () => assertGraphWorkflowDocumentValid(document),
      /non-empty expression/
    );
  });

  it("validates loop configuration numbers", () => {
    const build = (loop: Record<string, unknown>) => () =>
      new GraphWorkflowDocumentBuilder("doc", "Name")
        .addNode({
          id: "loop1",
          kind: "core.flow.loop",
          parameters: {},
          loop: { body: minimalDocument(), ...loop } as never,
        })
        .build();
    expectValidationError(build({ maxIterations: 0 }), /positive number/);
    expectValidationError(build({ timeoutMs: -1 }), /positive number .*milliseconds/);
    expectValidationError(build({ concurrency: 0 }), /positive number/);
    expectValidationError(
      () =>
        new GraphWorkflowDocumentBuilder("doc", "Name")
          .addNode({ id: "loop1", kind: "core.flow.loop", parameters: {}, loop: {} } as never)
          .build(),
      /requires a body document/
    );
  });

  it("validates loop mapping reference shapes", () => {
    const document = minimalDocument();
    document.nodes[0].loop = {
      body: minimalDocument(),
      inputMappings: { m: { source: "workflow" } } as never,
    };
    expectValidationError(
      () => assertGraphWorkflowDocumentValid(document),
      /referencing a workflow must reference a port/
    );

    const document2 = minimalDocument();
    document2.nodes[0].loop = {
      body: minimalDocument(),
      outputMappings: { m: { source: "literal", value: NaN } } as never,
    };
    expectValidationError(
      () => assertGraphWorkflowDocumentValid(document2),
      /literal references must be JSON-safe/
    );

    const document3 = minimalDocument();
    document3.nodes[0].loop = {
      body: minimalDocument(),
      inputMappings: { m: { source: "somewhere" } } as never,
    };
    expectValidationError(
      () => assertGraphWorkflowDocumentValid(document3),
      /workflow, node, literal, or expression/
    );
  });

  it("rejects self-referential (cyclic) loop bodies", () => {
    const document = minimalDocument();
    document.nodes[0].loop = { body: document } as never;
    expectValidationError(() => assertGraphWorkflowDocumentValid(document), /cyclic document/);
  });

  it("validates nested loop bodies recursively", () => {
    const innerBody = minimalDocument();
    innerBody.nodes[0].id = "deep";
    const nested = minimalDocument();
    nested.nodes[0].id = "mid";
    nested.nodes[0].loop = { body: innerBody } as never;
    const outer = minimalDocument();
    outer.nodes[0].id = "outer-loop";
    outer.nodes[0].kind = "core.flow.loop";
    outer.nodes[0].loop = { body: nested } as never;
    innerBody.nodes[0].inputBindings = { nope: { mode: "literal", value: NaN } };
    expectValidationError(() => assertGraphWorkflowDocumentValid(outer));
  });

  it("rejects workflow port schemas that are not GraphValueSchema", () => {
    const document = minimalDocument();
    document.inputs[0].schema = { type: "wat" } as never;
    expectValidationError(
      () => assertGraphWorkflowDocumentValid(document),
      /valid GraphValueSchema/
    );
  });

  it("omits undefined-valued settings/metadata/ui keys from raw builder output (JSON-safe and boundary-valid without a JSON clone)", () => {
    const probeEdge = {
      id: "re0",
      type: "data" as const,
      source: { scope: "workflow" as const, port: "in1" },
      target: { scope: "node" as const, nodeId: "n1", port: "value" },
    };

    const raw = new GraphWorkflowDocumentBuilder("probe-doc", "Probe Doc")
      .addInput({ id: "in1" })
      .addOutput({ id: "out1" })
      .addNode({ id: "n1", kind: "core.transform", parameters: {} })
      .addEdge(probeEdge)
      .build();
    expect(Object.hasOwn(raw, "settings")).toBe(false);
    expect(Object.hasOwn(raw, "metadata")).toBe(false);
    expect(Object.hasOwn(raw, "ui")).toBe(false);
    expect(findUndefinedOwnKeyPaths(raw)).toEqual([]);
    expect(isGraphJsonSafeValue(raw)).toBe(true);
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);

    const unset = new GraphWorkflowDocumentBuilder("probe-doc", "Probe Doc")
      .addInput({ id: "in1" })
      .addOutput({ id: "out1" })
      .addNode({ id: "n1", kind: "core.transform", parameters: {} })
      .addEdge(probeEdge)
      .setSettings({ retries: 2 })
      .setSettings(undefined)
      .setUi({ viewport: { x: 1, y: 2, zoom: 3 } })
      .setUi(undefined)
      .build();
    expect(Object.hasOwn(unset, "settings")).toBe(false);
    expect(Object.hasOwn(unset, "metadata")).toBe(false);
    expect(Object.hasOwn(unset, "ui")).toBe(false);
    expect(findUndefinedOwnKeyPaths(unset)).toEqual([]);
    expect(isGraphJsonSafeValue(unset)).toBe(true);
    expect(JSON.parse(JSON.stringify(unset))).toEqual(unset);

    const populated = new GraphWorkflowDocumentBuilder("probe-doc", "Probe Doc")
      .setSettings({ retries: 2 })
      .setMetadata({ team: "core" })
      .setUi({ viewport: { x: 1, y: 2, zoom: 1 } })
      .build();
    expect(Object.hasOwn(populated, "settings")).toBe(true);
    expect(Object.hasOwn(populated, "metadata")).toBe(true);
    expect(Object.hasOwn(populated, "ui")).toBe(true);
    expect(populated.settings).toEqual({ retries: 2 });
    expect(populated.metadata).toEqual({ team: "core" });
    expect(populated.ui).toEqual({ viewport: { x: 1, y: 2, zoom: 1 } });
    expect(JSON.parse(JSON.stringify(populated))).toEqual(populated);
  });
});
