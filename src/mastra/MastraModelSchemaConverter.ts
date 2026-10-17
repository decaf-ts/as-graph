/**
 * @module as-graph/mastra/MastraModelSchemaConverter
 * @summary The single decaf↔mastra schema conversion path (SAA-836 S1).
 * @description Every decaf Model → mastra Zod schema conversion (and the
 * reverse) goes through `@decaf-ts/as-zod` — this module is the mastra-side
 * adapter over it, never a second metadata walker. The converted schemas are
 * what mastra agents and workflow steps consume for structured output/input
 * (see {@link MastraStructuredOutput}). Both directions fail closed with
 * {@link GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE} when the conversion cannot
 * produce a usable schema, instead of handing the engine a degraded schema.
 */
import type { Constructor } from "@decaf-ts/decoration";
import type { Model } from "@decaf-ts/decorator-validation";
import { modelToZod, zodToModel } from "@decaf-ts/as-zod";
import type { z } from "zod";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";

/**
 * The schema conversion failed or produced no usable schema: the model carries
 * no convertible attributes, or the Zod schema is not an object schema that can
 * drive structured output (SAA-836 S1).
 */
export const GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE =
  "GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE";

/**
 * Converts a decaf Model constructor into the mastra Zod object schema through
 * `@decaf-ts/as-zod` (SAA-836 S1: the single conversion path). The result is
 * what mastra agents consume as their structured-output schema.
 *
 * @param model - The decaf Model constructor to convert.
 * @returns The converted Zod object schema.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE}
 *   when the model is not a decaf Model, or the conversion does not produce a
 *   Zod object schema.
 */
export function mastraSchemaFromModel<M extends Model>(
  model: Constructor<M>
): z.ZodTypeAny {
  if (typeof model !== "function") {
    throw new GraphExecutionError(
      "A decaf model constructor is required to convert to a mastra schema",
      GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE
    );
  }
  let converted: unknown;
  try {
    converted = modelToZod(model);
  } catch (error) {
    throw new GraphExecutionError(
      `Decaf model '${(model as { name?: string }).name ?? String(model)}' could not be converted to a mastra schema via @decaf-ts/as-zod: ${
        error instanceof Error ? error.message : String(error)
      }`,
      GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE
    );
  }
  if (!isZodObjectSchema(converted)) {
    throw new GraphExecutionError(
      `Decaf model '${(model as { name?: string }).name ?? String(model)}' converted to a schema that cannot drive mastra structured output`,
      GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE,
      { model: (model as { name?: string }).name }
    );
  }
  return converted;
}

/**
 * Converts a mastra Zod object schema back into a decaf Model constructor
 * through `@decaf-ts/as-zod` (SAA-836 S1: the single conversion path, reverse
 * direction).
 *
 * @param schema - The Zod schema to convert back.
 * @param name - Optional decaf model name the generated constructor registers.
 * @returns The generated decaf Model constructor.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE}
 *   when the schema is not convertible, or the generated constructor is not a
 *   decaf Model.
 */
export function mastraModelFromSchema(
  schema: z.ZodTypeAny,
  name?: string
): Constructor<Model> {
  if (!schema || typeof (schema as { parse?: unknown }).parse !== "function") {
    throw new GraphExecutionError(
      "A Zod schema is required to convert back to a decaf model",
      GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE
    );
  }
  let converted: unknown;
  try {
    converted = zodToModel<Model>(schema, name);
  } catch (error) {
    throw new GraphExecutionError(
      `The mastra Zod schema could not be converted back to a decaf model via @decaf-ts/as-zod: ${
        error instanceof Error ? error.message : String(error)
      }`,
      GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE
    );
  }
  if (typeof converted !== "function") {
    throw new GraphExecutionError(
      "The mastra Zod schema conversion produced no decaf model constructor",
      GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE
    );
  }
  return converted as Constructor<Model>;
}

/**
 * Structural check that an unknown conversion result is a Zod object schema
 * with a non-empty declared shape — the only schema shape that can drive
 * mastra structured output.
 *
 * @param candidate - The conversion result to check.
 * @returns `true` when the candidate is a Zod object schema.
 */
function isZodObjectSchema(candidate: unknown): candidate is z.ZodTypeAny {
  return (
    !!candidate &&
    typeof candidate === "object" &&
    typeof (candidate as { parse?: unknown }).parse === "function" &&
    !!(candidate as { shape?: unknown }).shape
  );
}
