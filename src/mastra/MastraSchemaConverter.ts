/**
 * @module as-graph/mastra/MastraSchemaConverter
 * @summary Converts canonical {@link GraphValueSchema} declarations into Zod
 * schemas for the Mastra backend (SAA-196).
 * @description Mastra workflows are built on Zod schemas. The converter maps
 * every canonical schema shape to its closest Zod equivalent, tracking whether
 * the conversion degraded (or collapsed to `any`), so suspendable steps can be
 * required to declare a strict, non-degraded resume schema before translation.
 */
import { z } from "zod";
import type { GraphValueSchema } from "../shared/graph/catalog/GraphValueSchema";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import { GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE } from "./types";

/** Result of converting one canonical schema into a Zod schema. */
export interface MastraZodConversion {
  /** The converted Zod schema (an `any` schema when degraded). */
  schema: z.ZodTypeAny;
  /** Whether any part of the canonical schema could not be represented. */
  degraded: boolean;
  /** Whether the whole conversion collapsed to a permissive `any` schema. */
  any: boolean;
}

/**
 * Recursively converts one canonical schema node into a Zod schema.
 *
 * @param schema - The canonical schema node to convert.
 * @returns The conversion result with its degradation flags.
 */
function convertValue(schema: GraphValueSchema): MastraZodConversion {
  switch (schema.type) {
    case "string":
      return { schema: z.string(), degraded: false, any: false };
    case "number": {
      let value = z.number();
      if (schema.integer === true) value = value.int();
      if (schema.min !== undefined) value = value.min(schema.min);
      if (schema.max !== undefined) value = value.max(schema.max);
      return { schema: value, degraded: false, any: false };
    }
    case "boolean":
      return { schema: z.boolean(), degraded: false, any: false };
    case "array": {
      const items = convertValue(schema.items);
      let value = z.array(items.schema);
      if (schema.minItems !== undefined) value = value.min(schema.minItems);
      if (schema.maxItems !== undefined) value = value.max(schema.maxItems);
      return { schema: value, degraded: items.degraded, any: false };
    }
    case "object": {
      const shape: Record<string, z.ZodTypeAny> = {};
      let degraded = false;
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        const converted = convertValue(property);
        shape[key] = converted.schema;
        degraded = degraded || converted.degraded;
      }
      let value = z.object(shape);
      if (schema.additionalProperties === true) {
        value = value.catchall(z.any());
      }
      return { schema: value, degraded, any: false };
    }
    case "enum": {
      const values = schema.values ?? [];
      if (values.length === 0) {
        return { schema: z.any(), degraded: true, any: true };
      }
      if (values.every((entry) => typeof entry === "string")) {
        return {
          schema: z.enum(values as unknown as [string, ...string[]]),
          degraded: false,
          any: false,
        };
      }
      const literals = values.map((entry) => z.literal(entry as never));
      const union =
        literals.length === 1 ? literals[0] : z.union(literals as never);
      return { schema: union, degraded: false, any: false };
    }
    case "model": {
      const shape: Record<string, z.ZodTypeAny> = {};
      let degraded = false;
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        const converted = convertValue(property);
        shape[key] = converted.schema;
        degraded = degraded || converted.degraded;
      }
      return { schema: z.object(shape), degraded, any: false };
    }
    case "any":
    default:
      return { schema: z.any(), degraded: true, any: true };
  }
}

/**
 * Converts a canonical schema (or the absence of one) into a Zod schema.
 * A missing schema converts to a degraded `any` schema.
 *
 * @param schema - The canonical schema to convert, if declared.
 * @returns The conversion result with its degradation flags.
 */
export function toMastraZodSchema(
  schema: GraphValueSchema | undefined
): MastraZodConversion {
  if (!schema) {
    return { schema: z.any(), degraded: true, any: true };
  }
  return convertValue(schema);
}

/**
 * Requires that a suspendable Mastra step declares a strict resume schema: the
 * conversion must be neither degraded nor collapsed to `any`, otherwise resume
 * payloads could not be validated (C15).
 *
 * @param schema - The declared resume schema of the suspended step.
 * @returns The validated Zod resume schema.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE} when
 *   the schema is missing, degraded, or collapsed to `any`.
 */
export function assertMastraResumeSchemaSafe(
  schema: GraphValueSchema | undefined
): z.ZodTypeAny {
  const converted = toMastraZodSchema(schema);
  if (converted.any || converted.degraded) {
    throw new GraphExecutionError(
      "A suspendable Mastra step requires a declared, non-degraded resume schema",
      GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE
    );
  }
  return converted.schema;
}
