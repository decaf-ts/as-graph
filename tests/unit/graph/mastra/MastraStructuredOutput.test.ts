/**
 * @module as-graph/tests/unit/graph/mastra/MastraStructuredOutput
 * @summary Driver tests for the backend structured-output/input contract
 * (SAA-836 S1, SAA-877).
 * @description Proves the definition guard and node-parameter reader (absent
 * or `undefined` parameters yield `undefined`; a DECLARED but malformed
 * definition throws `GRAPH_MASTRA_STRUCTURED_OUTPUT_MALFORMED` — fail closed,
 * Security verdict SAA-879 condition C1), that resolution prefers a
 * host-carried Zod schema over a model name, that a model name resolves
 * through the host registry and converts through the single `@decaf-ts/as-zod`
 * conversion path, and that every unresolvable definition fails closed with
 * `GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED`.
 */
import { describe, expect, it } from "@jest/globals";
import { Model, model, min, required } from "@decaf-ts/decorator-validation";
import { z } from "zod";
import {
  GRAPH_MASTRA_STRUCTURED_OUTPUT_MALFORMED,
  GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED,
  type MastraStructuredOutputDefinition,
  isMastraStructuredOutputDefinition,
  mastraStructuredOutputDefinitionOf,
  mastraStructuredOutputOf,
  resolveMastraStructuredOutput,
} from "../../../../src/mastra/MastraStructuredOutput";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import {
  mastraSchemaFromModel,
} from "../../../../src/mastra/MastraModelSchemaConverter";
import { node } from "../../../../src/workflows/builders";

/** A decorated decaf model used as the registry-resolved schema source. */
@model()
class InvoiceModel extends Model {
  constructor() {
    super();
    this.reference = "";
    this.amount = 0;
  }

  @required()
  reference!: string;

  @min(0)
  amount!: number;
}

/** A host registry resolving one decaf model name. */
function resolveModel(name: string) {
  return name === "InvoiceModel" ? InvoiceModel : undefined;
}

describe("isMastraStructuredOutputDefinition (SAA-836 S1)", () => {
  it("accepts the plain JSON-safe definition shape", () => {
    expect(isMastraStructuredOutputDefinition({ model: "InvoiceModel" })).toBe(
      true
    );
    expect(
      isMastraStructuredOutputDefinition({
        schema: z.object({ approved: z.boolean() }),
      })
    ).toBe(true);
    expect(
      isMastraStructuredOutputDefinition({
        model: "InvoiceModel",
        instructions: "Return strict JSON",
        jsonPromptInjection: "system",
        providerOptions: { temperature: 0 },
      })
    ).toBe(true);
    expect(isMastraStructuredOutputDefinition({})).toBe(true);
  });

  it("rejects malformed definitions", () => {
    expect(isMastraStructuredOutputDefinition(undefined)).toBe(false);
    expect(isMastraStructuredOutputDefinition(null)).toBe(false);
    expect(isMastraStructuredOutputDefinition("structured")).toBe(false);
    expect(isMastraStructuredOutputDefinition([])).toBe(false);
    expect(isMastraStructuredOutputDefinition({ model: 7 })).toBe(false);
    expect(
      isMastraStructuredOutputDefinition({ schema: { parse: "no" } })
    ).toBe(false);
    expect(
      isMastraStructuredOutputDefinition({ instructions: 42 })
    ).toBe(false);
    expect(
      isMastraStructuredOutputDefinition({ jsonPromptInjection: "bogus" })
    ).toBe(false);
    expect(isMastraStructuredOutputDefinition({ providerOptions: [] })).toBe(
      false
    );
  });
});

describe("mastraStructuredOutputDefinitionOf (SAA-836 S1)", () => {
  it("reads the canonical structuredOutput node parameter", () => {
    const definition: MastraStructuredOutputDefinition = {
      model: "InvoiceModel",
    };
    const subject = node("agent-1", "core.agent", {
      structuredOutput: definition,
    });

    expect(mastraStructuredOutputDefinitionOf(subject)).toEqual(definition);
  });

  it("returns undefined when the node declares none", () => {
    const subject = node("agent-1", "core.agent", { prompt: "hi" });

    expect(mastraStructuredOutputDefinitionOf(subject)).toBeUndefined();
  });

  it("treats an explicit structuredOutput: undefined as undeclared", () => {
    const subject = node("agent-1", "core.agent", {
      structuredOutput: undefined,
    });

    expect(mastraStructuredOutputDefinitionOf(subject)).toBeUndefined();
  });

  it("throws GRAPH_MASTRA_STRUCTURED_OUTPUT_MALFORMED for a declared malformed definition (fail closed, SAA-879 C1)", () => {
    const malformed: unknown[] = [{ model: 7 }, "structured", null];

    for (const candidate of malformed) {
      const subject = node("agent-1", "core.agent", {
        structuredOutput: candidate,
      });

      expect(() => mastraStructuredOutputDefinitionOf(subject)).toThrow(
        expect.objectContaining({
          graphCode: GRAPH_MASTRA_STRUCTURED_OUTPUT_MALFORMED,
        })
      );
      expect(() => mastraStructuredOutputDefinitionOf(subject)).toThrow(
        GraphExecutionError
      );
    }
  });

  it("propagates the malformed-definition throw from mastraStructuredOutputOf", () => {
    const subject = node("agent-1", "core.agent", {
      structuredOutput: { model: 42 },
    });

    expect(() =>
      mastraStructuredOutputOf(subject, resolveModel)
    ).toThrow(
      expect.objectContaining({
        graphCode: GRAPH_MASTRA_STRUCTURED_OUTPUT_MALFORMED,
      })
    );
  });
});

describe("resolveMastraStructuredOutput (SAA-836 S1)", () => {
  it("resolves a model name through the host registry via the as-zod path", () => {
    const resolved = resolveMastraStructuredOutput(
      { model: "InvoiceModel" },
      resolveModel
    );

    const schema = resolved.schema as z.ZodObject;
    expect(Object.keys(schema.shape).sort()).toEqual(["amount", "reference"]);
    expect(schema.shape["amount"].safeParse(-1).success).toBe(false);
  });

  it("prefers the host-carried Zod schema over the model name", () => {
    const hosted = z.object({ approved: z.boolean() });
    let resolverCalled = false;

    const resolved = resolveMastraStructuredOutput(
      { schema: hosted, model: "InvoiceModel" },
      (name) => {
        resolverCalled = true;
        return resolveModel(name);
      }
    );

    expect(resolverCalled).toBe(false);
    expect(resolved.schema).toBe(hosted);
  });

  it("forwards instructions, jsonPromptInjection, and providerOptions verbatim", () => {
    const providerOptions = { temperature: 0.2 };

    const resolved = resolveMastraStructuredOutput({
      model: "InvoiceModel",
      instructions: "Return strict JSON",
      jsonPromptInjection: "inline",
      providerOptions,
    }, resolveModel);

    expect(resolved.instructions).toBe("Return strict JSON");
    expect(resolved.jsonPromptInjection).toBe("inline");
    expect(resolved.providerOptions).toBe(providerOptions);
  });

  it("omits absent optional fields instead of sending nulls to mastra", () => {
    const resolved = resolveMastraStructuredOutput(
      { model: "InvoiceModel" },
      resolveModel
    );

    expect(resolved).toEqual({
      schema: expect.anything(),
    });
  });

  it("fails closed when no schema source resolves", () => {
    expect(() => resolveMastraStructuredOutput({})).toThrow(
      expect.objectContaining({
        graphCode: GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED,
      })
    );
  });

  it("fails closed when the referenced model name is unknown to the registry", () => {
    expect(() =>
      resolveMastraStructuredOutput({ model: "NoSuchModel" }, resolveModel)
    ).toThrow(
      expect.objectContaining({
        graphCode: GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED,
      })
    );
  });

  it("fails closed when a model name is referenced but no registry is supplied", () => {
    expect(() => resolveMastraStructuredOutput({ model: "InvoiceModel" }))
      .toThrow(expect.objectContaining({
        graphCode: GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED,
      }));
  });

  it("reaches the single conversion path when resolving through the registry", () => {
    // The model-name resolution converts through mastraSchemaFromModel
    // (@decaf-ts/as-zod): the resolved schema validates like the model's.
    const resolved = resolveMastraStructuredOutput(
      { model: "InvoiceModel" },
      resolveModel
    );

    expect((resolved.schema as z.ZodObject).shape["reference"].safeParse(undefined).success)
      .toBe(false);
  });
});

describe("mastraStructuredOutputOf (SAA-836 S1)", () => {
  it("resolves the node-level definition against the host registry", () => {
    const subject = node("agent-1", "core.agent", {
      structuredOutput: { model: "InvoiceModel" },
    });

    const resolved = mastraStructuredOutputOf(subject, resolveModel);

    expect(
      Object.keys((resolved!.schema as z.ZodObject).shape).sort()
    ).toEqual(["amount", "reference"]);
  });

  it("returns undefined when the node declares no structured output", () => {
    const subject = node("agent-1", "core.agent", { prompt: "hi" });

    expect(mastraStructuredOutputOf(subject, resolveModel)).toBeUndefined();
  });

  it("fails closed when a declared definition cannot resolve", () => {
    const subject = node("agent-1", "core.agent", {
      structuredOutput: { model: "NoSuchModel" },
    });

    expect(() => mastraStructuredOutputOf(subject, resolveModel)).toThrow(
      expect.objectContaining({
        graphCode: GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED,
      })
    );
  });

  it("survives the single conversion path: host schema and converted model are interchangeable", () => {
    const byModel = mastraStructuredOutputOf(
      node("a", "core.agent", { structuredOutput: { model: "InvoiceModel" } }),
      resolveModel
    );
    const hosted = mastraStructuredOutputOf(
      node("b", "core.agent", {
        structuredOutput: {
          schema: mastraSchemaFromModel(InvoiceModel),
        },
      })
    );

    expect(
      Object.keys((byModel!.schema as z.ZodObject).shape).sort()
    ).toEqual(Object.keys((hosted!.schema as z.ZodObject).shape).sort());
  });
});
