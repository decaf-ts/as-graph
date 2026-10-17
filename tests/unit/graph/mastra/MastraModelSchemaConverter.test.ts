/**
 * @module as-graph/tests/unit/graph/mastra/MastraModelSchemaConverter
 * @summary Driver tests for the single decaf↔mastra schema conversion path
 * (SAA-836 S1, SAA-877).
 * @description Proves that a decorated decaf Model converts through
 * `@decaf-ts/as-zod` into a Zod object schema whose shape carries the model's
 * attributes and whose validation constraints survive (a `@min(0)` attribute
 * rejects negatives), that a Zod object schema converts back into a named
 * decaf Model constructor, and that every unusable conversion result fails
 * closed with `GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE`.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { Model, model, min, required } from "@decaf-ts/decorator-validation";
import { z } from "zod";
import {
  GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE,
  mastraModelFromSchema,
  mastraSchemaFromModel,
} from "../../../../src/mastra/MastraModelSchemaConverter";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";

/** A decorated decaf model with a required string and a `@min(0)` number. */
@model()
class ReportModel extends Model {
  constructor() {
    super();
    this.title = "";
    this.count = 0;
  }

  @required()
  title!: string;

  @min(0)
  count!: number;
}

describe("mastraSchemaFromModel (SAA-836 S1)", () => {
  it("converts a decorated decaf model into a Zod object schema", () => {
    const schema = mastraSchemaFromModel(ReportModel) as z.ZodObject;

    expect(typeof schema.parse).toBe("function");
    expect(Object.keys(schema.shape).sort()).toEqual(["count", "title"]);
  });

  it("carries the model's validation constraints: @min(0) rejects negatives", () => {
    const schema = mastraSchemaFromModel(ReportModel) as z.ZodObject;

    expect(schema.shape["count"].safeParse(-1).success).toBe(false);
    expect(schema.shape["count"].safeParse(3).success).toBe(true);
    expect(schema.shape["title"].safeParse("monthly").success).toBe(true);
    expect(schema.shape["title"].safeParse(undefined).success).toBe(false);
  });

  it("rejects a non-constructor input (fail closed)", () => {
    for (const bad of [undefined, null, 42, "ReportModel", {}, []]) {
      expect(() => mastraSchemaFromModel(bad as never)).toThrow(
        GraphExecutionError
      );
      try {
        mastraSchemaFromModel(bad as never);
        throw new Error(`expected a throw for ${String(bad)}`);
      } catch (error) {
        expect((error as GraphExecutionError).graphCode).toBe(
          GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE
        );
      }
    }
  });

  it("fails closed when the conversion produces a non-object schema", async () => {
    jest.resetModules();
    jest.doMock("@decaf-ts/as-zod", () => ({
      ...jest.requireActual("@decaf-ts/as-zod"),
      modelToZod: () => "not-a-schema",
    }));
    try {
      // Importing through the mock ensures the converter binds the stubbed
      // `modelToZod` instead of the real one.
      const { mastraSchemaFromModel: convertWithStub } = await import(
        "../../../../src/mastra/MastraModelSchemaConverter"
      );

      expect(() => convertWithStub(ReportModel)).toThrow(
        expect.objectContaining({
          graphCode: GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE,
        })
      );
    } finally {
      jest.dontMock("@decaf-ts/as-zod");
      jest.resetModules();
    }
  });

  it("wraps an as-zod conversion failure as a fail-closed error", async () => {
    jest.resetModules();
    jest.doMock("@decaf-ts/as-zod", () => ({
      ...jest.requireActual("@decaf-ts/as-zod"),
      modelToZod: () => {
        throw new Error("conversion exploded");
      },
    }));
    try {
      const { mastraSchemaFromModel: convertWithStub } = await import(
        "../../../../src/mastra/MastraModelSchemaConverter"
      );

      expect(() => convertWithStub(ReportModel)).toThrow(
        expect.objectContaining({
          graphCode: GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE,
        })
      );
    } finally {
      jest.dontMock("@decaf-ts/as-zod");
      jest.resetModules();
    }
  });
});

describe("mastraModelFromSchema (SAA-836 S1)", () => {
  it("converts a Zod object schema back into a named decaf model constructor", () => {
    const schema = mastraSchemaFromModel(ReportModel) as z.ZodObject;

    const generated = mastraModelFromSchema(schema, "GeneratedReport");

    expect(typeof generated).toBe("function");
    expect((generated as { name?: string }).name).toBe("GeneratedReport");
  });

  it("round-trips: the generated model converts back to an equivalent schema", () => {
    const schema = mastraSchemaFromModel(ReportModel) as z.ZodObject;
    const generated = mastraModelFromSchema(schema, "GeneratedReport");

    const roundTripped = mastraSchemaFromModel(generated) as z.ZodObject;

    expect(Object.keys(roundTripped.shape).sort()).toEqual(
      Object.keys(schema.shape).sort()
    );
    expect(roundTripped.shape["count"].safeParse(-1).success).toBe(false);
  });

  it("accepts a generated model without an explicit name", () => {
    const schema = mastraSchemaFromModel(ReportModel) as z.ZodObject;

    const generated = mastraModelFromSchema(schema);

    expect(typeof generated).toBe("function");
  });

  it("rejects a non-schema input (fail closed)", () => {
    for (const bad of [undefined, null, {}, "schema", 7]) {
      expect(() => mastraModelFromSchema(bad as never)).toThrow(
        expect.objectContaining({
          graphCode: GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE,
        })
      );
    }
  });

  it("rejects a non-object Zod schema (fail closed)", () => {
    expect(() => mastraModelFromSchema(z.string())).toThrow(
      expect.objectContaining({
        graphCode: GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE,
      })
    );
  });

  it("rejects a non-function zodToModel output (fail closed)", async () => {
    jest.resetModules();
    jest.doMock("@decaf-ts/as-zod", () => ({
      ...jest.requireActual("@decaf-ts/as-zod"),
      zodToModel: () => "not-a-constructor",
    }));
    try {
      // Importing through the mock ensures the converter binds the stubbed
      // `zodToModel` instead of the real one.
      const { mastraModelFromSchema: backConvertWithStub } = await import(
        "../../../../src/mastra/MastraModelSchemaConverter"
      );

      expect(() => backConvertWithStub(z.object({}))).toThrow(
        expect.objectContaining({
          graphCode: GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE,
        })
      );
    } finally {
      jest.dontMock("@decaf-ts/as-zod");
      jest.resetModules();
    }
  });
});
