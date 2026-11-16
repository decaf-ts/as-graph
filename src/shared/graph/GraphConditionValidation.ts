/**
 * @module as-graph/shared/graph/GraphConditionValidation
 * @summary Structural validation of a flow-control condition.
 * @description If, Switch, While, Until and Filter carry a condition in one of
 * three shapes: a declarative expression (`{ op, left, right }`), a code
 * condition (`{ type: "code", code }`), or a built-in comparison
 * (`{ type: "equals", left, right }`). A malformed one used to surface only
 * when the node ran, as a raw `TypeError`. This check runs at validation time
 * and is frontend-safe, so an editor can report the same problems inline.
 */

const COMPARISON_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);
const BUILT_IN_TYPES = new Set([
  "truthy",
  "falsy",
  "equals",
  "notEquals",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "exists",
  "custom",
]);
const MAX_CONDITION_DEPTH = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function operandProblem(value: unknown, side: string): string | undefined {
  if (!isRecord(value)) {
    return `'${side}' must be an operand object ({ const }, { path } or { step, path }), not ${
      value === null ? "null" : Array.isArray(value) ? "a list" : `a bare ${typeof value}`
    }`;
  }
  if ("const" in value) return undefined;
  if (typeof value["path"] === "string") return undefined;
  return `'${side}' must carry 'const' or a string 'path'`;
}

/**
 * Lists what is structurally wrong with a condition.
 *
 * @param condition - The condition value as persisted on the node.
 * @param depth - Current nesting depth (internal).
 * @returns Human-readable problems; empty when the condition is well formed.
 */
export function graphConditionProblemsOf(
  condition: unknown,
  depth = 0
): string[] {
  if (!isRecord(condition)) {
    return ["a condition must be an object"];
  }
  if (depth > MAX_CONDITION_DEPTH) {
    return ["the condition is nested too deeply"];
  }
  if (condition["type"] === "code") {
    return typeof condition["code"] === "string" &&
      condition["code"].trim() !== ""
      ? []
      : ["a code condition needs non-empty 'code'"];
  }
  const op = condition["op"];
  if (typeof op === "string") {
    if (COMPARISON_OPS.has(op)) {
      return [
        operandProblem(condition["left"], "left"),
        operandProblem(condition["right"], "right"),
      ].filter((entry): entry is string => entry !== undefined);
    }
    if (op === "and" || op === "or") {
      const list = condition["conditions"];
      if (!Array.isArray(list) || list.length === 0) {
        return [`'${op}' needs a non-empty 'conditions' list`];
      }
      return list.flatMap((entry) => graphConditionProblemsOf(entry, depth + 1));
    }
    if (op === "not") {
      return graphConditionProblemsOf(condition["condition"], depth + 1);
    }
    if (op === "exists") {
      const problem = operandProblem(condition["value"], "value");
      return problem ? [problem] : [];
    }
    return [`unknown operator '${op}'`];
  }
  const type = condition["type"];
  if (typeof type === "string") {
    return BUILT_IN_TYPES.has(type) ? [] : [`unknown condition type '${type}'`];
  }
  return ["a condition needs an 'op' or a 'type'"];
}
