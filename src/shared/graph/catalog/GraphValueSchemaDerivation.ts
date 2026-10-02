import { ValidationKeys, type ValidatorOptions } from "@decaf-ts/decorator-validation";
import { isGraphJsonPrimitive } from "../document/GraphJsonValue";
import type { Constructor } from "@decaf-ts/decoration";
import type {
  GraphJsonPrimitive,
  GraphNumberValueSchema,
  GraphStringValueSchema,
  GraphValueSchema,
  GraphValueSchemaType,
} from "./GraphValueSchema";

/**
 * Decaf validation metadata keyed by validator name, used to derive a value schema.
 */
export type GraphValidationRecord = Record<string, ValidatorOptions>;

const GRAPH_TYPE_NAME_MAP: Record<string, GraphValueSchemaType> = {
  string: "string",
  char: "string",
  text: "string",
  textarea: "string",
  radio: "string",
  select: "string",
  number: "number",
  integer: "number",
  float: "number",
  double: "number",
  decimal: "number",
  boolean: "boolean",
  bool: "boolean",
  checkbox: "boolean",
  array: "array",
  list: "array",
  set: "array",
  object: "object",
  model: "model",
  any: "any",
  unknown: "any",
  enum: "enum",
};

const GRAPH_DATE_TYPE_NAME_FORMATS: Record<string, string> = {
  date: "date",
  datetime: "date-time",
  "date-time": "date-time",
  duration: "duration",
};

export { GRAPH_DATE_TYPE_NAME_FORMATS };

/**
 * Maps a Decaf/TypeScript type name to a {@link GraphValueSchemaType}, defaulting to `any`.
 */
export function graphTypeNameToSchemaType(typeName: string | undefined): GraphValueSchemaType {
  if (!typeName) return "any";
  return GRAPH_TYPE_NAME_MAP[typeName.toLowerCase()] ?? "any";
}

/**
 * Maps a date-like type name to its schema `format`, when known.
 */
export function graphDateTypeNameToFormat(typeName: string | undefined): string | undefined {
  if (!typeName) return undefined;
  return GRAPH_DATE_TYPE_NAME_FORMATS[typeName.toLowerCase()];
}

function validationValue(validation: GraphValidationRecord, key: string): unknown {
  const entry = validation[key] as Record<string, unknown> | undefined;
  if (!entry || typeof entry !== "object") return undefined;
  return entry["value"];
}

function numericConstraintOf(validation: GraphValidationRecord, key: string): number | undefined {
  const value = validationValue(validation, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Extracts enum values from a validation record, when present and primitive.
 */
export function graphEnumValuesFromValidation(
  validation: GraphValidationRecord
): GraphJsonPrimitive[] | undefined {
  const raw = validationValue(validation, ValidationKeys.ENUM);
  if (Array.isArray(raw) && raw.every(isGraphJsonPrimitive)) {
    return raw as GraphJsonPrimitive[];
  }
  return undefined;
}

function customTypeNameFromValidation(validation: GraphValidationRecord): string | undefined {
  const typeEntry = validation[ValidationKeys.TYPE] as
    | { customTypes?: Array<{ name?: string } | string> }
    | undefined;
  const custom = typeEntry?.customTypes?.[0];
  const name =
    typeof custom === "function"
      ? (custom as { name?: string }).name
      : (custom as { name?: string } | undefined)?.name;
  if (!name) return undefined;
  return name;
}

/**
 * Derives a {@link GraphValueSchema} from a port's validation metadata, type name and model name.
 */
export function graphValueSchemaFromValidation(
  validation: GraphValidationRecord | undefined,
  typeName?: string,
  modelName?: string
): GraphValueSchema {
  const v = validation ?? {};
  const enumValues = graphEnumValuesFromValidation(v);
  if (enumValues) return { type: "enum", values: enumValues };
  const customTypeName = customTypeNameFromValidation(v) ?? modelName;
  if (customTypeName) return { type: "model", name: customTypeName };
  return baseSchemaForType(typeName, v);
}

function baseSchemaForType(
  typeName: string | undefined,
  v: GraphValidationRecord
): GraphValueSchema {
  switch (graphTypeNameToSchemaType(typeName)) {
    case "string": {
      const format = graphDateTypeNameToFormat(typeName);
      const schema: GraphStringValueSchema =
        format !== undefined ? { type: "string", format } : { type: "string" };
      return schema;
    }
    case "number": {
      const schema: GraphNumberValueSchema = { type: "number" };
      if (typeName && typeName.toLowerCase() === "integer") schema.integer = true;
      const min = numericConstraintOf(v, ValidationKeys.MIN);
      const max = numericConstraintOf(v, ValidationKeys.MAX);
      if (min !== undefined) schema.min = min;
      if (max !== undefined) schema.max = max;
      return schema;
    }
    case "boolean":
      return { type: "boolean" };
    case "array":
      return batchArrayValueSchema(v, typeName);
    case "object":
      return { type: "object", properties: {} };
    case "enum":
      return { type: "enum", values: [] };
    case "model":
      return { type: "model", name: typeName ?? "any" };
    default:
      return { type: "any" };
  }
}

function batchArrayValueSchema(
  v: GraphValidationRecord,
  typeName: string | undefined
): GraphValueSchema {
  const schema: { type: "array"; items: GraphValueSchema; minItems?: number; maxItems?: number } = {
    type: "array",
    items: arrayItemsSchemaOf(v, typeName),
  };
  const min = numericConstraintOf(v, ValidationKeys.MIN);
  const max = numericConstraintOf(v, ValidationKeys.MAX);
  if (min !== undefined) schema.minItems = min;
  if (max !== undefined) schema.maxItems = max;
  return schema;
}

function arrayItemsSchemaOf(
  v: GraphValidationRecord,
  typeName: string | undefined
): GraphValueSchema {
  if (isModelListItems(v)) return { type: "model", name: modelListNameOf(v) };
  const itemType = validationValue(v, ValidationKeys.TYPE);
  if (typeof itemType === "string") {
    const itemTypeKind = graphTypeNameToSchemaType(itemType);
    return itemTypeKind === "model"
      ? { type: "model", name: itemType }
      : ({ type: itemTypeKind } as GraphValueSchema);
  }
  if (typeName && typeName !== "array") {
    const typeKind = graphTypeNameToSchemaType(typeName);
    return typeKind === "model"
      ? { type: "model", name: typeName }
      : ({ type: typeKind } as GraphValueSchema);
  }
  return { type: "any" };
}

function isModelListItems(v: GraphValidationRecord): boolean {
  const list = v[ValidationKeys.LIST] as
    | { clazz?: Constructor<never>[] | (() => Constructor<never>)[] }
    | undefined;
  return Boolean(list?.clazz?.length);
}

function modelListNameOf(v: GraphValidationRecord): string {
  const list = v[ValidationKeys.LIST] as
    | { clazz?: Constructor<never>[] | (() => Constructor<never>)[] }
    | undefined;
  const first = list?.clazz?.[0];
  if (typeof first !== "function") return "any";
  if ((first as { name?: string }).name) return (first as { name: string }).name;
  try {
    const lazy = (first as () => Constructor<never>)();
    if (typeof lazy === "function" && lazy.name) return lazy.name;
  } catch {
    return "any";
  }
  return "any";
}
