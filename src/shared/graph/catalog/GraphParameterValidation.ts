/**
 * Declarative validation rule attached to a parameter definition: required, numeric bound, step, length, pattern, enum or method.
 */
export type GraphParameterValidation =
  | { kind: "required"; message?: string }
  | { kind: "min" | "max" | "step" | "minLength" | "maxLength"; value: number; message?: string }
  | { kind: "pattern"; value: string; message?: string }
  | { kind: "enum"; values: (string | number | boolean)[]; message?: string }
  | { kind: "method"; method: string; message?: string };

/**
 * The declared parameter-validation vocabulary.
 */
export const GRAPH_PARAMETER_VALIDATION_KINDS = [
  "required",
  "min",
  "max",
  "step",
  "minLength",
  "maxLength",
  "pattern",
  "enum",
  "method",
] as const;

/**
 * Discriminator string of a {@link GraphParameterValidation}.
 */
export type GraphParameterValidationKind = (typeof GRAPH_PARAMETER_VALIDATION_KINDS)[number];

/**
 * Type guard for {@link GraphParameterValidationKind}.
  * @returns {boolean} Whether `value` is a GraphParameterValidationKind.
*/
export function isGraphParameterValidationKind(value: unknown): value is GraphParameterValidationKind {
  return (GRAPH_PARAMETER_VALIDATION_KINDS as readonly string[]).includes(value as string);
}

/**
 * Type guard for {@link GraphParameterValidation}, checking the fields each `kind` requires.
  * @returns {boolean} Whether `value` is a GraphParameterValidation.
*/
export function isGraphParameterValidation(value: unknown): value is GraphParameterValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = (value as Record<string, unknown>)["kind"];
  if (!isGraphParameterValidationKind(kind)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  switch (kind) {
    case "required":
      return keys.length <= 2;
    case "min":
    case "max":
    case "step":
    case "minLength":
    case "maxLength":
      return (
        keys.includes("value") &&
        typeof (value as Record<string, unknown>)["value"] === "number" &&
        Number.isFinite((value as Record<string, unknown>)["value"] as number) &&
        keys.length <= 3
      );
    case "pattern":
      return keys.includes("value") && typeof (value as Record<string, unknown>)["value"] === "string" && keys.length <= 3;
    case "enum":
      return (
        keys.includes("values") &&
        Array.isArray((value as Record<string, unknown>)["values"]) &&
        ((value as Record<string, unknown>)["values"] as unknown[]).every(
          (entry) => typeof entry !== "object"
        ) &&
        keys.length <= 3
      );
    case "method":
      return keys.includes("method") && typeof (value as Record<string, unknown>)["method"] === "string" && keys.length <= 3;
    default:
      return false;
  }
}

/**
 * Type guard for an array of {@link GraphParameterValidation}.
  * @returns {boolean} Whether `value` is a GraphParameterValidation[].
*/
export function isGraphParameterValidationList(value: unknown): value is GraphParameterValidation[] {
  return Array.isArray(value) && value.every(isGraphParameterValidation);
}
