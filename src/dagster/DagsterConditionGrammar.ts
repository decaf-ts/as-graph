/**
 * @module as-graph/dagster/DagsterConditionGrammar
 * @summary Validated graphical-condition translation for Dagster (SAA-193 C7).
 * @description Translates a canonical `ConditionExpression` into a structured
 * condition spec embedded in Dagster run config as data. The translator accepts
 * only the validated graphical grammar: path segments must match
 * `[A-Za-z0-9_]+`, and node-step references must match `[A-Za-z0-9_.-]+`.
 * Any path carrying quotes, backslashes, `$`, braces, or whitespace is rejected
 * with `GRAPH_DAGSTER_PATH_REJECTED` — it is never sanitized into compliance.
 * Constants are checked for JSON safety (SAA-193 C10).
 */
import type {
  ConditionExpression,
  ExprValue,
  GraphJsonValue,
} from "../shared/graph";
import { isGraphJsonSafeValue } from "../shared/graph";
import { DAGSTER_ERROR } from "./constants";
import { GraphExecutionError } from "../engine/errors";

/** A validated dotted path segment. */
const DAGSTER_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_]+$/;

/** A validated cross-node step reference (a node id). */
const DAGSTER_STEP_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * A validated operand embedded in a translated condition spec.
 */
export type DagsterOperandSpec =
  | { kind: "const"; value: GraphJsonValue }
  | { kind: "path"; path: string }
  | { kind: "step"; step: string; path: string };

/**
 * A validated condition spec embedded in Dagster run config as data. The generated
 * Python evaluator consumes this data; no condition text is ever inlined into code.
 */
export type DagsterConditionSpec =
  | { op: "exists"; value: DagsterOperandSpec }
  | {
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
      left: DagsterOperandSpec;
      right: DagsterOperandSpec;
    }
  | { op: "and" | "or"; conditions: DagsterConditionSpec[] }
  | { op: "not"; condition: DagsterConditionSpec };

/**
 * Validates and returns a dotted condition path, rejecting any path that fails
 * the validated grammar (SAA-193 C7).
 *
 * @param path - The dotted path to validate.
 * @param detail - Optional context for the rejection message.
 * @returns The validated path.
 * @throws {GraphExecutionError} `GRAPH_DAGSTER_PATH_REJECTED` when a segment is invalid.
 */
export function assertDagsterPath(path: string, detail?: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new GraphExecutionError(
      `Dagster condition path is empty${detail ? ` (${detail})` : ""}`,
      DAGSTER_ERROR.PATH_REJECTED,
      { path, detail }
    );
  }
  for (const segment of path.split(".")) {
    if (!DAGSTER_PATH_SEGMENT_PATTERN.test(segment)) {
      throw new GraphExecutionError(
        `Dagster condition path '${path}' has an invalid segment '${segment}'${detail ? ` (${detail})` : ""}`,
        DAGSTER_ERROR.PATH_REJECTED,
        { path, segment, detail }
      );
    }
  }
  return path;
}

/**
 * Validates and returns a cross-node step reference, rejecting any value that
 * fails the validated grammar (SAA-193 C7).
 *
 * @param step - The node id reference to validate.
 * @returns The validated step reference.
 * @throws {GraphExecutionError} `GRAPH_DAGSTER_PATH_REJECTED` when invalid.
 */
export function assertDagsterStep(step: string): string {
  if (typeof step !== "string" || !DAGSTER_STEP_PATTERN.test(step)) {
    throw new GraphExecutionError(
      `Dagster condition step reference '${step}' is invalid`,
      DAGSTER_ERROR.PATH_REJECTED,
      { step }
    );
  }
  return step;
}

/**
 * Translates a canonical `ExprValue` operand into a validated operand spec.
 *
 * @param value - The expression value to translate.
 * @returns The validated operand spec.
 * @throws {GraphExecutionError} `GRAPH_DAGSTER_PATH_REJECTED` on an invalid path,
 *   or `GRAPH_DAGSTER_TRANSLATION_JSON_UNSAFE` on a non-JSON-safe constant.
 */
export function translateDagsterOperand(value: ExprValue): DagsterOperandSpec {
  if ("const" in value) {
    if (!isGraphJsonSafeValue(value.const)) {
      throw new GraphExecutionError(
        "Dagster condition constant is not JSON-safe",
        DAGSTER_ERROR.TRANSLATION_JSON_UNSAFE,
        { value: value.const }
      );
    }
    return { kind: "const", value: value.const as GraphJsonValue };
  }
  if ("step" in value) {
    const step = assertDagsterStep(value.step);
    return { kind: "step", step, path: assertDagsterPath(value.path) };
  }
  return { kind: "path", path: assertDagsterPath(value.path) };
}

/**
 * Translates a validated graphical `ConditionExpression` into a condition spec.
 *
 * @param condition - The canonical condition to translate.
 * @returns The validated condition spec.
 * @throws {GraphExecutionError} when a path or constant fails validation.
 */
export function translateDagsterCondition(
  condition: ConditionExpression
): DagsterConditionSpec {
  switch (condition.op) {
    case "and":
    case "or":
      return {
        op: condition.op,
        conditions: condition.conditions.map((entry) =>
          translateDagsterCondition(entry)
        ),
      };
    case "not":
      return {
        op: "not",
        condition: translateDagsterCondition(condition.condition),
      };
    case "exists":
      return { op: "exists", value: translateDagsterOperand(condition.value) };
    default:
      return {
        op: condition.op,
        left: translateDagsterOperand(condition.left),
        right: translateDagsterOperand(condition.right),
      };
  }
}
