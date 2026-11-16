/**
 * @module as-graph/tests/unit/graph/GraphValidationContracts.test
 * @summary Condition structure, port value types, wired-value coercion and
 * form-only fields.
 */
import { describe, it, expect } from "@jest/globals";
import { graphConditionProblemsOf } from "../../../src/shared/graph";
import { graphPortTypeMismatchOf } from "../../../src/engine/validation/GraphEdgeInstanceValidator";
import { coerceWiredConfigurationValue } from "../../../src/engine/catalog/GraphBuiltInRegistrations";
import { GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND } from "../../../src/node";
import { document, edge, node, port } from "../../../src/workflows/builders";
import { bootFixtureEngine } from "../../fixtures/workflow-engine";

describe("graphConditionProblemsOf", () => {
  it.each([
    [{ op: "gt", left: { path: "n" }, right: { const: 1 } }],
    [{ op: "and", conditions: [{ op: "exists", value: { path: "a" } }] }],
    [{ op: "not", condition: { op: "eq", left: { const: 1 }, right: { const: 1 } } }],
    [{ type: "code", code: "return true;" }],
    [{ type: "truthy", left: "value" }],
  ])("accepts %j", (condition) => {
    expect(graphConditionProblemsOf(condition)).toEqual([]);
  });

  it.each([
    [{ op: "gt", left: { path: "n" }, right: 10 }, /'right' must be an operand object/],
    [{ op: "gt", left: {}, right: { const: 1 } }, /'left' must carry/],
    [{ op: "between" }, /unknown operator 'between'/],
    [{ op: "and", conditions: [] }, /non-empty 'conditions'/],
    [{ type: "code", code: " " }, /non-empty 'code'/],
    [{ type: "sometimes" }, /unknown condition type/],
    [{}, /needs an 'op' or a 'type'/],
    ["n > 1", /must be an object/],
  ])("rejects %j", (condition, message) => {
    expect(graphConditionProblemsOf(condition).join("; ")).toMatch(message);
  });
});

describe("condition validation at the gate", () => {
  it("reports a malformed If condition instead of failing at run time", async () => {
    const { engine } = await bootFixtureEngine();
    const doc = document({
      id: "v-bad-condition",
      inputs: [port("n")],
      outputs: [port("out")],
      nodes: [
        node("if", "core.flow.if", {
          condition: { op: "gt", left: { path: "value" }, right: 10 },
        } as never),
      ],
      edges: [
        edge("e1", ["workflow", "n"], ["node", "if", "value"]),
        edge("e2", ["node", "if", "then"], ["workflow", "out"]),
      ],
    });
    const validation = await engine.validateWorkflowDocument(doc);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual([
      expect.objectContaining({
        code: "parameter.invalid-condition",
        nodeId: "if",
        path: expect.stringContaining("parameters.condition"),
      }),
    ]);
  });
});

describe("graphPortTypeMismatchOf", () => {
  const out = (type: string) => ({ schema: { type } });
  const config = (type: string) => ({ schema: { type }, configurable: true });

  it("rejects definite mismatches onto a configuration port", () => {
    expect(graphPortTypeMismatchOf(out("array"), config("number"))).toEqual({
      from: "array",
      to: "number",
    });
    expect(graphPortTypeMismatchOf(out("string"), config("array"))).toBeDefined();
    expect(graphPortTypeMismatchOf(out("boolean"), config("number"))).toBeDefined();
  });

  it("allows coercible, untyped and data-port wirings", () => {
    expect(graphPortTypeMismatchOf(out("string"), config("number"))).toBeUndefined();
    expect(graphPortTypeMismatchOf(out("any"), config("number"))).toBeUndefined();
    expect(graphPortTypeMismatchOf(out("object"), config("boolean"))).toBeUndefined();
    expect(
      graphPortTypeMismatchOf(out("array"), { schema: { type: "number" } })
    ).toBeUndefined();
  });

  it("is applied by the edge stage", async () => {
    const { engine } = await bootFixtureEngine();
    const doc = document({
      id: "v-type-mismatch",
      inputs: [port("items")],
      outputs: [port("out")],
      nodes: [
        node("sort", "core.data.sort", {}),
        node("limit", "core.data.limit", {}),
      ],
      edges: [
        edge("e1", ["workflow", "items"], ["node", "sort", "value"]),
        edge("e2", ["node", "sort", "result"], ["node", "limit", "value"]),
        // A list routed onto a numeric configuration field.
        edge("e3", ["node", "sort", "result"], ["node", "limit", "maxItems"]),
        edge("e4", ["node", "limit", "result"], ["workflow", "out"]),
      ],
    });
    const validation = await engine.validateWorkflowDocument(doc);
    expect(validation.issues.map((issue) => issue.code)).toContain(
      "edge.value-type-mismatch"
    );
  });
});

describe("coerceWiredConfigurationValue", () => {
  const coerce = (value: unknown, schema: Record<string, unknown>) =>
    coerceWiredConfigurationValue(value, schema, "n", "p");

  it("reads numeric and boolean text the way a form does", () => {
    expect(coerce("5", { type: "number" })).toBe(5);
    expect(coerce(7, { type: "number" })).toBe(7);
    expect(coerce("true", { type: "boolean" })).toBe(true);
    expect(coerce(3, { type: "string" })).toBe("3");
    expect(coerce("b", { type: "enum", values: ["a", "b"] })).toBe("b");
  });

  it("fails closed on a value the port cannot hold", () => {
    for (const [value, schema] of [
      ["not-a-number", { type: "number" }],
      ["yes", { type: "boolean" }],
      ["c", { type: "enum", values: ["a", "b"] }],
      ["x", { type: "array" }],
    ] as const) {
      expect(() => coerce(value, schema)).toThrow(
        expect.objectContaining({ graphCode: "GRAPH_INPUT_TYPE_MISMATCH" })
      );
    }
  });

  it("fails the node when a wired value has the wrong type", async () => {
    const { engine } = await bootFixtureEngine();
    const doc = document({
      id: "v-wired-coercion",
      inputs: [port("items"), port("max")],
      outputs: [port("out")],
      nodes: [node("limit", "core.data.limit", {})],
      edges: [
        edge("e1", ["workflow", "items"], ["node", "limit", "value"]),
        edge("e2", ["workflow", "max"], ["node", "limit", "maxItems"]),
        edge("e3", ["node", "limit", "result"], ["workflow", "out"]),
      ],
    });
    const ok = await engine.execute(doc, { items: [1, 2, 3], max: "2" });
    expect(ok.outputs.out).toEqual([1, 2]);
    const bad = await engine.execute(doc, { items: [1, 2, 3], max: "many" });
    expect(bad.status).toBe("failed");
    expect(bad.nodeResults.limit.error?.code).toBe("GRAPH_INPUT_TYPE_MISMATCH");
  });
});

describe("form-only fields", () => {
  it("publishes the Code node's language as an options parameter with its default", () => {
    const language = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[
      "core.utility.code"
    ].parameters.find((parameter) => parameter.id === "language");
    expect(language).toMatchObject({
      type: "options",
      defaultValue: "javascript",
      options: [
        { value: "javascript", label: "javascript" },
        { value: "typescript", label: "typescript" },
      ],
    });
    // A form-only field is not a port.
    expect(
      GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND["core.utility.code"].inputs.map(
        (entry) => entry.id
      )
    ).not.toContain("language");
  });
});
