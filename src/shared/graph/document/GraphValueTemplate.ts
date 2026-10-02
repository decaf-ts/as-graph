import { isGraphJsonValue } from "./GraphJsonValue";
import type { GraphJsonValue } from "./GraphJsonValue";

/**
 * The modes a user-controllable node property value may be provided in, in
 * addition to a straight literal value (DECAF-50 node rules). `expression` is a
 * code expression evaluated with the code-evaluator VM under its default
 * settings; `template` is a text template whose `${...}`/`{{ ... }}` placeholders
 * are replaced with the resolved workflow values.
 */
export const GRAPH_VALUE_TEMPLATE_MODES = ["expression", "template"] as const;

/** A value-template mode (`expression` or `template`). */
export type GraphValueTemplateMode =
  (typeof GRAPH_VALUE_TEMPLATE_MODES)[number];

/**
 * Languages a code expression / text template may declare. The four-value contract
 * the board specified: `javascript` / `typescript` for code expressions and
 * `json` / `text` for text templates.
 */
export const GRAPH_VALUE_TEMPLATE_LANGUAGES = [
  "javascript",
  "typescript",
  "json",
  "text",
] as const;

/** A language a code expression / text template may declare. */
export type GraphValueTemplateLanguage =
  (typeof GRAPH_VALUE_TEMPLATE_LANGUAGES)[number];

/**
 * A user-controllable node property value supplied as a code expression or a text
 * template instead of a straight literal. Instances are JSON-safe and are stored in
 * the node instance's `parameters`, so they persist with the rest of the workflow
 * document and survive save/load round-trips.
 */
export interface GraphValueTemplate {
  mode: GraphValueTemplateMode;
  /** The expression or template body. */
  expression: string;
  /**
   * The evaluation language. Defaults to `javascript` for `expression` mode and
   * `text` for `template` mode when omitted.
   */
  language?: GraphValueTemplateLanguage;
  /** Free-form template settings persisted with the workflow. */
  metadata?: Record<string, string>;
}

/**
 * Type guard for {@link GraphValueTemplateMode}.
 *
 * @returns {boolean} Whether `value` is a declared value-template mode.
 */
export function isGraphValueTemplateMode(
  value: unknown
): value is GraphValueTemplateMode {
  return (GRAPH_VALUE_TEMPLATE_MODES as readonly string[]).includes(
    value as string
  );
}

/**
 * Type guard for {@link GraphValueTemplateLanguage}.
 *
 * @returns {boolean} Whether `value` is a declared value-template language.
 */
export function isGraphValueTemplateLanguage(
  value: unknown
): value is GraphValueTemplateLanguage {
  return (GRAPH_VALUE_TEMPLATE_LANGUAGES as readonly string[]).includes(
    value as string
  );
}

/**
 * Type guard for {@link GraphValueTemplate}, checking the required `mode` and
 * `expression` fields and the optional `language`.
 *
 * @returns {boolean} Whether `value` is a graph value template.
 */
export function isGraphValueTemplate(
  value: unknown
): value is GraphValueTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!isGraphValueTemplateMode(record["mode"])) return false;
  if (typeof record["expression"] !== "string" || !record["expression"]) {
    return false;
  }
  if (
    record["language"] !== undefined &&
    !isGraphValueTemplateLanguage(record["language"])
  ) {
    return false;
  }
  if (
    record["metadata"] !== undefined &&
    !isGraphJsonValue(record["metadata"])
  ) {
    return false;
  }
  return true;
}

/**
 * The default language for a value-template mode: `javascript` for `expression`,
 * `text` for `template`.
 *
 * @param mode - The value-template mode.
 * @returns The default language for that mode.
 */
export function graphValueTemplateDefaultLanguage(
  mode: GraphValueTemplateMode
): GraphValueTemplateLanguage {
  return mode === "expression" ? "javascript" : "text";
}

/**
 * Resolves a persisted node parameter value: a straight JSON value is returned
 * unchanged; a {@link GraphValueTemplate} is evaluated through the supplied
 * evaluator (the code-evaluator VM for expressions, the template evaluator for
 * templates) using the value's declared language or the mode default.
 *
 * @param value - The persisted parameter value.
 * @param evaluate - Evaluates an expression/template body in a language.
 * @returns The resolved JSON-safe value.
 */
export function resolveGraphValueTemplate(
  value: GraphJsonValue,
  evaluate: (
    expression: string,
    language: GraphValueTemplateLanguage
  ) => GraphJsonValue
): GraphJsonValue {
  if (!isGraphValueTemplate(value)) return value;
  const language =
    value.language ?? graphValueTemplateDefaultLanguage(value.mode);
  return evaluate(value.expression, language);
}
