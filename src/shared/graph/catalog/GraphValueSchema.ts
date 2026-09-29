import type { GraphJsonPrimitive } from "../document/GraphJsonValue";

export type { GraphJsonValue, GraphJsonPrimitive } from "../document/GraphJsonValue";

/**
 * Schema for a value of any JSON type.
 */
export type GraphAnyValueSchema = { type: "any" };

/**
 * Schema for a string value, with an optional format.
 */
export type GraphStringValueSchema = {
  type: "string";
  format?: string;
};

/**
 * Schema for a number value, optionally integer and bounded.
 */
export type GraphNumberValueSchema = {
  type: "number";
  integer?: boolean;
  min?: number;
  max?: number;
};

/**
 * Schema for a boolean value.
 */
export type GraphBooleanValueSchema = { type: "boolean" };

/**
 * Schema for a homogeneous array value.
 */
export type GraphArrayValueSchema = {
  type: "array";
  items: GraphValueSchema;
  minItems?: number;
  maxItems?: number;
};

/**
 * Schema for a structured object value.
 */
export type GraphObjectValueSchema = {
  type: "object";
  properties: Record<string, GraphValueSchema>;
  required?: string[];
  additionalProperties?: boolean;
};

/**
 * Schema for a value constrained to a fixed set.
 */
export type GraphEnumValueSchema = {
  type: "enum";
  values: GraphJsonPrimitive[];
};

/**
 * Schema for a Decaf model value.
 */
export type GraphModelValueSchema = {
  type: "model";
  name: string;
  properties?: Record<string, GraphValueSchema>;
};

/**
 * Union of every value schema a port or parameter may declare.
 */
export type GraphValueSchema =
  | GraphAnyValueSchema
  | GraphStringValueSchema
  | GraphNumberValueSchema
  | GraphBooleanValueSchema
  | GraphArrayValueSchema
  | GraphObjectValueSchema
  | GraphEnumValueSchema
  | GraphModelValueSchema;

/**
 * The declared value-schema vocabulary.
 */
export const GRAPH_VALUE_SCHEMA_TYPES = [
  "any",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "enum",
  "model",
] as const;

/**
 * Discriminator string of a {@link GraphValueSchema}.
 */
export type GraphValueSchemaType = (typeof GRAPH_VALUE_SCHEMA_TYPES)[number];

/**
 * Type guard for {@link GraphValueSchemaType}.
  * @returns {boolean} Whether `value` is a GraphValueSchemaType.
*/
export function isGraphValueSchemaType(value: unknown): value is GraphValueSchemaType {
  return (GRAPH_VALUE_SCHEMA_TYPES as readonly string[]).includes(value as string);
}

/**
 * Type guard for {@link GraphValueSchema}.
  * @returns {boolean} Whether `value` is a GraphValueSchema.
*/
export function isGraphValueSchema(value: unknown): value is GraphValueSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return isGraphValueSchemaType((value as Record<string, unknown>)["type"]);
}
