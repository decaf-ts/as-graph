/**
 * DECAF-50/P1 evidence: endpoints are tagged scope objects, and the canonical
 * document serializer/deserializer is lossless and refuse-y at the boundary.
 */
import { ValidationError } from "@decaf-ts/db-decorators";
import {
  graphWorkflowDocumentDeserializer,
  graphWorkflowDocumentSerializer,
  isGraphEndpoint,
  isGraphNodeEndpoint,
  isGraphWorkflowEndpoint,
  GraphWorkflowDocumentBuilder,
} from "../../../src/shared/graph";
import type { GraphEndpoint, GraphWorkflowDocument } from "../../../src/shared/graph";

function buildDocument(): GraphWorkflowDocument {
  return new GraphWorkflowDocumentBuilder("serial-doc", "Serial Doc")
    .addInput({ id: "in1", schema: { type: "string" }, required: true })
    .addOutput({ id: "out1", schema: { type: "number" } })
    .addNode({ id: "n1", kind: "core.transform", parameters: { value: "start" } })
    .addNode({
      id: "loop1",
      kind: "core.flow.loop",
      parameters: {},
      loop: {
        body: new GraphWorkflowDocumentBuilder("loop-body", "Loop Body")
          .addInput({ id: "items" })
          .addNode({ id: "inner", kind: "core.transform", parameters: { value: "inner" } })
          .addEdge({
            id: "re0",
            type: "data",
            source: { scope: "workflow", port: "items" },
            target: { scope: "node", nodeId: "inner", port: "value" },
          })
          .build(),
        maxIterations: 4,
      },
    })
    .addEdge({
      id: "re0",
      type: "data",
      source: { scope: "workflow", port: "in1" },
      target: { scope: "node", nodeId: "n1", port: "value" },
    })
    .addEdge({
      id: "re1",
      type: "connection",
      source: { scope: "node", nodeId: "n1", port: "modelRes" },
      target: { scope: "node", nodeId: "loop1", port: "items" },
      label: "model handle",
    })
    .setMetadata({ owner: "saa" })
    .build();
}

describe("endpoint shape", () => {
  it("accepts exactly the two tagged endpoint shapes", () => {
    const workflowEndpoint: GraphEndpoint = { scope: "workflow", port: "in1" };
    const nodeEndpoint: GraphEndpoint = { scope: "node", nodeId: "n1", port: "value" };
    expect(isGraphEndpoint(workflowEndpoint)).toBe(true);
    expect(isGraphEndpoint(nodeEndpoint)).toBe(true);
    expect(isGraphWorkflowEndpoint(workflowEndpoint)).toBe(true);
    expect(isGraphNodeEndpoint(nodeEndpoint)).toBe(true);
  });

  it("rejects every other endpoint shape", () => {
    const rejected: unknown[] = [
      "n1",
      "$workflow",
      null,
      undefined,
      42,
      [],
      { scope: "workflow", port: "in1", extra: 1 },
      { scope: "workflow" },
      { scope: "workflow", port: 5 },
      { scope: "node", nodeId: "n1", port: "value", extra: true },
      { scope: "node", port: "value" },
      { scope: "node", nodeId: "n1" },
      { scope: "somewhere", port: "value" },
    ];
    for (const value of rejected) {
      expect(isGraphEndpoint(value)).toBe(false);
    }
  });
});

describe("document serialization", () => {
  it("round-trips the canonical document exactly (including nested loop bodies)", () => {
    const document = buildDocument();
    const serialised = graphWorkflowDocumentSerializer(document);
    expect(typeof serialised).toBe("string");
    const parsed = graphWorkflowDocumentDeserializer(serialised);
    expect(parsed).toEqual(document);
    expect(parsed.nodes[1].loop?.body?.id).toBe("loop-body");
    expect(parsed.nodes[1].loop?.maxIterations).toBe(4);
  });

  it("serializes without a $workflow sentinel anywhere", () => {
    const serialised = graphWorkflowDocumentSerializer(buildDocument());
    expect(serialised).not.toContain("$workflow");
    expect(serialised).toContain('"scope": "workflow"');
  });

  it("refuses documents that do not have the canonical shape", () => {
    expect(() => graphWorkflowDocumentSerializer({ id: "x" } as never)).toThrow(ValidationError);
    expect(() =>
      graphWorkflowDocumentSerializer(
        { id: "x", name: "X", inputs: [], outputs: [], nodes: "nope", edges: [] } as never
      )
    ).toThrow(/canonical GraphWorkflowDocument shape/);
  });

  it("refuses non-JSON and unsafe payloads on deserialization", () => {
    expect(() => graphWorkflowDocumentDeserializer("{oops")).toThrow(/not valid JSON/);
    expect(() => graphWorkflowDocumentDeserializer("{}")).toThrow(
      /not shaped as a canonical GraphWorkflowDocument/
    );
    expect(() =>
      graphWorkflowDocumentDeserializer(
        '{"id":"x","name":"X","inputs":[],"outputs":[],"nodes":[],"edges":[],"__proto__":{"bad":1}}'
      )
    ).toThrow(ValidationError);
  });

  it("refuses payload documents whose nested content fails document validation", () => {
    const bad = {
      id: "x",
      name: "X",
      inputs: [],
      outputs: [],
      nodes: [
        {
          id: "l",
          kind: "core.flow.loop",
          parameters: {},
          loop: { body: { id: "y", name: "", inputs: [], outputs: [], nodes: [], edges: [] } },
        },
      ],
      edges: [],
    };
    expect(() => graphWorkflowDocumentDeserializer(JSON.stringify(bad))).toThrow(
      /name.*non-empty/i
    );
  });
});
