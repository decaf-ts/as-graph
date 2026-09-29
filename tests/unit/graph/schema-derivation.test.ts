/**
 * DECAF-50/P1 evidence: catalog schema derivation, visibility expressions, and
 * dynamic port rules. Functions are refused by the JSON-safety guard that the
 * (de)serializers apply on every catalog value.
 */
import { ValidationError } from "@decaf-ts/db-decorators";
import {
  GRAPH_DYNAMIC_PORT_RULE_TYPES,
  GRAPH_VALUE_SCHEMA_TYPES,
  GRAPH_VISIBILITY_OPS,
  graphDateTypeNameToFormat,
  graphEnumValuesFromValidation,
  graphTypeNameToSchemaType,
  graphValueSchemaFromValidation,
  isGraphDynamicPortRule,
  isGraphDynamicPortRuleType,
  isGraphJsonSafeValue,
  isGraphValueSchema,
  isGraphValueSchemaType,
  isGraphVisibilityExpression,
  graphJsonSerializer,
} from "../../../src/shared/graph";
import type { GraphValidationRecord } from "../../../src/shared/graph";

describe("value schema variants", () => {
  const variants: unknown[] = [
    { type: "any" },
    { type: "string", format: "date-time" },
    { type: "number", integer: true, min: 0, max: 10 },
    { type: "boolean" },
    { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
    { type: "object", properties: { a: { type: "any" } }, required: ["a"] },
    { type: "enum", values: ["a", 1, true, null] },
    { type: "model", name: "Order", properties: { id: { type: "string" } } },
  ];

  it("recognizes every schema variant", () => {
    expect(GRAPH_VALUE_SCHEMA_TYPES).toEqual([
      "any",
      "string",
      "number",
      "boolean",
      "array",
      "object",
      "enum",
      "model",
    ]);
    for (const variant of variants) {
      expect(isGraphValueSchema(variant)).toBe(true);
    }
  });

  it("rejects unknown types and non-objects", () => {
    expect(isGraphValueSchemaType("wat")).toBe(false);
    expect(isGraphValueSchemaType("string")).toBe(true);
    expect(isGraphValueSchema({ type: "wat" })).toBe(false);
    expect(isGraphValueSchema({ type: "string" })).toBe(true);
    expect(isGraphValueSchema({})).toBe(false);
    expect(isGraphValueSchema("string")).toBe(false);
    expect(isGraphValueSchema(null)).toBe(false);
    expect(isGraphValueSchema([{ type: "any" }])).toBe(false);
  });

  it("keeps every variant JSON-safe (functions cannot appear inside them)", () => {
    for (const variant of variants) {
      expect(isGraphJsonSafeValue(variant)).toBe(true);
    }
    expect(isGraphJsonSafeValue({ type: "model", name: "X", hooks: () => 1 })).toBe(false);
    expect(() =>
      graphJsonSerializer({ type: "model", name: "X", hooks: () => 1 } as never)
    ).toThrow(ValidationError);
  });
});

describe("schema derivation from validation", () => {
  it("maps type names to schema types", () => {
    expect(graphTypeNameToSchemaType("string")).toBe("string");
    expect(graphTypeNameToSchemaType("text")).toBe("string");
    expect(graphTypeNameToSchemaType("NUMBER")).toBe("number");
    expect(graphTypeNameToSchemaType("integer")).toBe("number");
    expect(graphTypeNameToSchemaType("bool")).toBe("boolean");
    expect(graphTypeNameToSchemaType("list")).toBe("array");
    expect(graphTypeNameToSchemaType("unknown")).toBe("any");
    expect(graphTypeNameToSchemaType(undefined)).toBe("any");
    expect(graphTypeNameToSchemaType("whatever")).toBe("any");
  });

  it("maps date-ish type names to formats", () => {
    expect(graphDateTypeNameToFormat("date")).toBe("date");
    expect(graphDateTypeNameToFormat("datetime")).toBe("date-time");
    expect(graphDateTypeNameToFormat("date-time")).toBe("date-time");
    expect(graphDateTypeNameToFormat("duration")).toBe("duration");
    expect(graphDateTypeNameToFormat("string")).toBeUndefined();
  });

  it("derives enum schemas from enum validation values", () => {
    const record: GraphValidationRecord = {
      enum: { value: ["alpha", "beta"] } as never,
    };
    expect(graphEnumValuesFromValidation(record)).toEqual(["alpha", "beta"]);
    expect(graphValueSchemaFromValidation(record, "string")).toEqual({
      type: "enum",
      values: ["alpha", "beta"],
    });
  });

  it("ignores enum records whose raw value is not a primitive list", () => {
    expect(graphEnumValuesFromValidation({ enum: { value: [{ a: 1 }] } } as never)).toBeUndefined();
    expect(graphEnumValuesFromValidation({} as never)).toBeUndefined();
  });

  it("derives numeric schemas with min/max constraints and integer flags", () => {
    const record: GraphValidationRecord = {
      min: { value: 5 } as never,
      max: { value: 10 } as never,
    };
    expect(graphValueSchemaFromValidation(record, "number")).toEqual({
      type: "number",
      min: 5,
      max: 10,
    });
    expect(graphValueSchemaFromValidation(record, "integer")).toEqual({
      type: "number",
      integer: true,
      min: 5,
      max: 10,
    });
  });

  it("derives model schemas from custom type validation or model names", () => {
    const record = { type: { customTypes: [{ name: "Order" }] } } as never as GraphValidationRecord;
    expect(graphValueSchemaFromValidation(record)).toEqual({ type: "model", name: "Order" });
    expect(graphValueSchemaFromValidation(undefined, "string", "Widget")).toEqual({
      type: "model",
      name: "Widget",
    });
  });

  it("derives array schemas, including model item lists and size constraints", () => {
    const typed: GraphValidationRecord = {
      type: { value: "string" } as never,
      min: { value: 1 } as never,
      max: { value: 9 } as never,
    };
    expect(graphValueSchemaFromValidation(typed, "array")).toEqual({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 9,
    });
    class LineItem {}
    const modelList = { list: { clazz: [LineItem] } } as never as GraphValidationRecord;
    expect(graphValueSchemaFromValidation(modelList, "array")).toEqual({
      type: "array",
      items: { type: "model", name: "LineItem" },
    });
    expect(graphValueSchemaFromValidation({} as never, "array")).toEqual({
      type: "array",
      items: { type: "any" },
    });
  });

  it("falls back to base schemas for scalar and object types", () => {
    expect(graphValueSchemaFromValidation({} as never, "string")).toEqual({ type: "string" });
    expect(graphValueSchemaFromValidation({} as never, "boolean")).toEqual({ type: "boolean" });
    expect(graphValueSchemaFromValidation({} as never, "object")).toEqual({
      type: "object",
      properties: {},
    });
    expect(graphValueSchemaFromValidation(undefined, "enum")).toEqual({ type: "enum", values: [] });
    expect(graphValueSchemaFromValidation(undefined, undefined)).toEqual({ type: "any" });
  });
});

describe("visibility expressions", () => {
  it("accepts the full operator grammar with exact key sets", () => {
    expect(GRAPH_VISIBILITY_OPS).toEqual([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "notIn",
      "exists",
      "and",
      "or",
      "not",
    ]);
    const valid: unknown[] = [
      { op: "eq", parameter: "mode", value: "strict" },
      { op: "gt", parameter: "count", value: 3 },
      { op: "lte", parameter: "ratio", value: 0.5 },
      { op: "in", parameter: "mode", values: ["strict", "fast"] },
      { op: "notIn", parameter: "flag", values: [true] },
      { op: "exists", parameter: "brief" },
      { op: "and", expressions: [{ op: "exists", parameter: "a" }, { op: "eq", parameter: "b", value: 1 }] },
      { op: "or", expressions: [{ op: "neq", parameter: "a", value: null }] },
      { op: "not", expression: { op: "exists", parameter: "hidden" } },
    ];
    for (const expression of valid) {
      expect(isGraphVisibilityExpression(expression)).toBe(true);
    }
  });

  it("rejects malformed expressions", () => {
    const invalid: unknown[] = [
      null,
      undefined,
      "eq",
      [],
      { op: "wat", parameter: "a", value: 1 },
      { op: "eq", parameter: "a" },
      { op: "eq", value: 1 },
      { op: "eq", parameter: "a", value: 1, extra: true },
      { op: "eq", parameter: 4, value: 1 },
      { op: "in", parameter: "a", values: [{ nested: true }] },
      { op: "in", parameter: "a", values: "strict" },
      { op: "exists", parameter: "a", value: 1 },
      { op: "and", expressions: [{ op: "wat" }] },
      { op: "and", expressions: {} },
      { op: "not", expression: { op: "exists" } },
    ];
    for (const expression of invalid) {
      expect(isGraphVisibilityExpression(expression)).toBe(false);
    }
  });

  it("keeps function values out of serialized expressions via the JSON guard", () => {
    const smuggled = { op: "eq", parameter: "a", value: () => true };
    expect(isGraphVisibilityExpression(smuggled)).toBe(true);
    expect(isGraphJsonSafeValue(smuggled)).toBe(false);
    expect(() => graphJsonSerializer(smuggled)).toThrow(ValidationError);
  });
});

describe("dynamic port rules", () => {
  it("recognizes the declared rule types", () => {
    expect(GRAPH_DYNAMIC_PORT_RULE_TYPES).toEqual(["repeatFromParameter", "togglePort"]);
    expect(isGraphDynamicPortRuleType("togglePort")).toBe(true);
    expect(isGraphDynamicPortRuleType("repeatFromParam")).toBe(false);
  });

  it("accepts valid repeat and toggle rules", () => {
    expect(
      isGraphDynamicPortRule({
        type: "repeatFromParameter",
        parameter: "rows",
        itemIdPath: "id",
        itemLabelPath: "name",
        direction: "input",
        portIdTemplate: "row-${id}",
        defaultPort: { id: "row", direction: "input", schema: { type: "any" } },
      })
    ).toBe(true);
    expect(
      isGraphDynamicPortRule({
        type: "togglePort",
        parameter: "attachModel",
        equals: true,
        port: {
          id: "modelRes",
          label: "Model",
          direction: "connection",
          schema: { type: "any" },
        },
      })
    ).toBe(true);
  });

  it("rejects malformed rules", () => {
    const invalid: unknown[] = [
      null,
      [],
      "togglePort",
      { type: "unknownRule", parameter: "p" },
      { type: "repeatFromParameter", parameter: "p", itemIdPath: "id", direction: "input" },
      {
        type: "repeatFromParameter",
        parameter: "p",
        itemIdPath: "id",
        direction: "sideways",
        portIdTemplate: "t",
      },
      { type: "repeatFromParameter", itemIdPath: "id", direction: "input", portIdTemplate: "t" },
      { type: "togglePort", parameter: "p", equals: null, port: { id: "x" } },
      { type: "togglePort", parameter: "p", equals: true },
    ];
    for (const rule of invalid) {
      expect(isGraphDynamicPortRule(rule)).toBe(false);
    }
  });
});
