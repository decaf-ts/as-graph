/**
 * @module as-graph/nodes/data/support
 * @summary Shared data-manipulation helpers for the Data node family.
 * @description Path-addressed record/array helpers used by the `core.data.*`
 * node kinds (set, merge, filter, splitOut, limit, sort, renameKeys, dateTime,
 * dataTable) and reused by the `core.io.*` nodes that decode file payloads.
 * All path accessors split dotted paths into segments, treat non-record
 * intermediates as "not found", and reject reserved prototype-pollution
 * segments (`__proto__`, `constructor`, `prototype`) before any access, so a
 * configured path can never reach an object's prototype chain.
 */
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";

/**
 * Coercion targets for a configured assignment value.
 *
 * `json` (the default) parses string values as JSON and passes everything else
 * through unchanged; `string`, `number`, and `boolean` convert via `String`,
 * `Number`, and truthiness (`"true"`/`"1"` for strings); `array` wraps
 * non-array values in a one-element array; `object` keeps records and maps
 * everything else to `{}`.
 */
export type GraphDataSetValueType =
  | "string"
  | "number"
  | "boolean"
  | "json"
  | "array"
  | "object";

const RESERVED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Type guard for plain graph data records.
 *
 * @param value - The value to test.
 * @returns `true` when the value is a non-null, non-array object (the shape the
 * Data nodes treat as a keyed record).
 */
export function isGraphDataRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes an input into an array of items.
 *
 * `undefined` becomes an empty array (the nil case the engine's nil-skipping
 * semantics rely on), arrays are returned as-is, and any other single value is
 * wrapped in a one-element array. This is the "array-in, array-out" contract
 * shared by the Data nodes.
 *
 * @param value - The raw input value.
 * @returns The item list to iterate.
 */
export function asGraphDataArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry) => entry !== undefined && entry !== null);
}

/**
 * Splits a dotted path into its non-empty, trimmed segments.
 *
 * @param path - The configured path, e.g. `"user.name"`.
 * @returns The segments; an empty array when the path is blank.
 */
export function splitGraphDataPath(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Splits a path and rejects reserved prototype-pollution segments.
 *
 * @param path - The configured path.
 * @returns The validated segments.
 * @throws {GraphExecutionError} with code `GRAPH_DATA_UNSAFE_PATH` when any
 *   segment is `__proto__`, `constructor`, or `prototype`.
 */
export function assertGraphDataPath(path: string): string[] {
  const segments = splitGraphDataPath(path);
  for (const segment of segments) {
    assertGraphDataSegment(path, segment);
  }
  return segments;
}

/**
 * Rejects a reserved prototype-pollution key.
 *
 * Literal-key mode (no dot notation) bypasses path splitting, so the same
 * reserved-key check is applied to the whole key: a configured `__proto__`
 * assignment must fail even when it is not split into segments.
 *
 * @param path - The configured path or literal key, for the error message.
 * @param segment - The single key being accessed.
 * @throws {GraphExecutionError} with code `GRAPH_DATA_UNSAFE_PATH` when the key
 *   is `__proto__`, `constructor`, or `prototype`.
 */
function assertGraphDataSegment(path: string, segment: string): void {
  if (RESERVED_PATH_SEGMENTS.has(segment)) {
    throw new GraphExecutionError(
      `Graph data path '${path}' contains the reserved segment '${segment}'`,
      "GRAPH_DATA_UNSAFE_PATH",
      { path, segment }
    );
  }
}

/**
 * Validates a path in either dotted or literal-key mode.
 *
 * @param path - The configured path or literal key.
 * @param dotNotation - When false (default true), the whole path is a single
 *   literal key.
 * @returns The segments to traverse.
 * @throws {GraphExecutionError} with code `GRAPH_DATA_UNSAFE_PATH` when the
 *   dotted path or literal key contains a reserved segment.
 */
function graphDataSegments(path: string, dotNotation: boolean): string[] {
  if (dotNotation) return assertGraphDataPath(path);
  assertGraphDataSegment(path, path);
  return [path];
}

/**
 * Reads a value from a nested record.
 *
 * Traversal stops with `undefined` as soon as an intermediate segment is not a
 * record, so missing chains resolve to `undefined` instead of throwing. An
 * empty path returns the source unchanged.
 *
 * @param source - The value to read from.
 * @param path - The dotted path, or a literal key when `dotNotation` is false.
 * @param dotNotation - When false (default true), the whole path is treated as
 *   a single literal key.
 * @returns The resolved value, or `undefined` when not reachable.
 */
export function getGraphDataValue(
  source: unknown,
  path: string,
  dotNotation = true
): unknown {
  if (!path) return source;
  const segments = graphDataSegments(path, dotNotation);
  let current: unknown = source;
  for (const segment of segments) {
    if (!isGraphDataRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Writes a value into a nested record.
 *
 * Missing intermediate segments are created as empty records. Paths are
 * validated first, so a reserved segment throws instead of polluting the
 * prototype chain. An empty path is a no-op.
 *
 * @param target - The record to mutate.
 * @param path - The dotted path, or a literal key when `dotNotation` is false.
 * @param value - The value to assign.
 * @param dotNotation - When false (default true), the whole path is treated as
 *   a single literal key.
 * @throws {GraphExecutionError} with code `GRAPH_DATA_UNSAFE_PATH` when the
 *   dotted path contains a reserved segment.
 */
export function setGraphDataValue(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
  dotNotation = true
): void {
  const segments = graphDataSegments(path, dotNotation);
  if (segments.length === 0) return;
  let current: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    const next = current[segment];
    if (!isGraphDataRecord(next)) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    } else {
      current = next;
    }
  }
  current[segments[segments.length - 1]] = value;
}

/**
 * Deletes a value from a nested record.
 *
 * A missing or non-record intermediate chain is a silent no-op rather than an
 * error, matching the read helper's "not found" semantics.
 *
 * @param target - The record to mutate.
 * @param path - The dotted path, or a literal key when `dotNotation` is false.
 * @param dotNotation - When false (default true), the whole path is treated as
 *   a single literal key.
 * @throws {GraphExecutionError} with code `GRAPH_DATA_UNSAFE_PATH` when the
 *   dotted path contains a reserved segment.
 */
export function deleteGraphDataValue(
  target: Record<string, unknown>,
  path: string,
  dotNotation = true
): void {
  const segments = graphDataSegments(path, dotNotation);
  if (segments.length === 0) return;
  let current: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index++) {
    const next: unknown = current[segments[index]];
    if (!isGraphDataRecord(next)) return;
    current = next;
  }
  delete current[segments[segments.length - 1]];
}

/**
 * Coerces a configured value to a declared type.
 *
 * `undefined`/`null` pass through untouched so an unassigned field stays
 * nil-skipped by the caller. `json` (the default) parses strings as JSON and
 * keeps the raw string when parsing fails; the other targets convert as
 * described on {@link GraphDataSetValueType}.
 *
 * @param value - The raw configured value.
 * @param type - The target type; defaults to `json`.
 * @returns The coerced value, or the original nil input.
 * @throws {GraphExecutionError} with code `GRAPH_DATA_INVALID_NUMBER` when a
 *   `number` coercion does not produce a finite number.
 */
export function coerceGraphDataSetValue(
  value: unknown,
  type: GraphDataSetValueType = "json"
): unknown {
  if (value === undefined || value === null) return value;
  switch (type) {
    case "string":
      return String(value);
    case "number": {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new GraphExecutionError(
          `Value '${String(value)}' cannot be converted to a number`,
          "GRAPH_DATA_INVALID_NUMBER",
          { value }
        );
      }
      return number;
    }
    case "boolean":
      if (typeof value === "string") {
        return value === "true" || value === "1";
      }
      return Boolean(value);
    case "array":
      return Array.isArray(value) ? value : [value];
    case "object":
      return isGraphDataRecord(value) ? value : {};
    case "json":
    default:
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
  }
}

/**
 * Compares two values for sorting.
 *
 * Nil values (`undefined`/`null`) always sort after defined values, and two
 * nils are equal. `auto` compares numbers and booleans numerically and
 * everything else by string; `string`, `number`, and `date` force the
 * respective comparison.
 *
 * @param left - The left operand.
 * @param right - The right operand.
 * @param type - The comparison mode; defaults to `auto`.
 * @returns A negative number, zero, or a positive number as for `sort`.
 */
export function compareGraphDataValues(
  left: unknown,
  right: unknown,
  type: "auto" | "string" | "number" | "date" = "auto"
): number {
  const leftNil = left === undefined || left === null;
  const rightNil = right === undefined || right === null;
  if (leftNil && rightNil) return 0;
  if (leftNil) return 1;
  if (rightNil) return -1;
  if (type === "string") return String(left).localeCompare(String(right));
  if (type === "number") return Number(left) - Number(right);
  if (type === "date") {
    return new Date(left as string).getTime() - new Date(right as string).getTime();
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  return String(left).localeCompare(String(right));
}

/**
 * Formats a date using a token pattern.
 *
 * Supported tokens are `yyyy`, `yy`, `MM`, `M`, `dd`, `d`, `HH`, `H`, `mm`,
 * `m`, `ss`, `s`, and `SSS`, all evaluated in UTC. A missing format (or the
 * literal `iso`) yields the ISO-8601 string.
 *
 * @param date - The date to format.
 * @param format - The token pattern, or omitted/`"iso"` for ISO-8601.
 * @returns The formatted date string.
 */
export function formatGraphDate(
  date: Date,
  format?: string
): string {
  if (!format || format === "iso") return date.toISOString();
  const pad = (value: number, length = 2) =>
    String(value).padStart(length, "0");
  const replacements: Record<string, string> = {
    yyyy: String(date.getUTCFullYear()),
    yy: String(date.getUTCFullYear()).slice(-2),
    MM: pad(date.getUTCMonth() + 1),
    M: String(date.getUTCMonth() + 1),
    dd: pad(date.getUTCDate()),
    d: String(date.getUTCDate()),
    HH: pad(date.getUTCHours()),
    H: String(date.getUTCHours()),
    mm: pad(date.getUTCMinutes()),
    m: String(date.getUTCMinutes()),
    ss: pad(date.getUTCSeconds()),
    s: String(date.getUTCSeconds()),
    SSS: pad(date.getUTCMilliseconds(), 3),
  };
  return format.replace(
    /yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s|SSS/g,
    (token) => replacements[token] ?? token
  );
}

/**
 * Adds an amount of a unit to a date.
 *
 * The input date is never mutated; arithmetic runs on a UTC copy, and month
 * overflow behaves as the built-in `Date` semantics dictate (e.g. Jan 31 +
 * 1 month rolls into March).
 *
 * @param date - The base date.
 * @param amount - The (possibly negative) amount to add.
 * @param unit - The unit of `amount`.
 * @returns The shifted copy of the date.
 */
export function addGraphDateUnits(
  date: Date,
  amount: number,
  unit: "seconds" | "minutes" | "hours" | "days" | "weeks" | "months" | "years"
): Date {
  const result = new Date(date.getTime());
  switch (unit) {
    case "seconds":
      result.setUTCSeconds(result.getUTCSeconds() + amount);
      break;
    case "minutes":
      result.setUTCMinutes(result.getUTCMinutes() + amount);
      break;
    case "hours":
      result.setUTCHours(result.getUTCHours() + amount);
      break;
    case "days":
      result.setUTCDate(result.getUTCDate() + amount);
      break;
    case "weeks":
      result.setUTCDate(result.getUTCDate() + amount * 7);
      break;
    case "months":
      result.setUTCMonth(result.getUTCMonth() + amount);
      break;
    case "years":
      result.setUTCFullYear(result.getUTCFullYear() + amount);
      break;
  }
  return result;
}

/**
 * Parses a node input into a `Date`.
 *
 * Accepts `Date` instances, epoch-millisecond numbers, and non-empty
 * (ISO-8601 or otherwise `Date`-parsable) strings.
 *
 * @param value - The raw input value.
 * @returns The parsed date.
 * @throws {GraphExecutionError} with code `GRAPH_DATA_INVALID_DATE` when the
 *   value is an invalid `Date` or cannot be parsed from a number or string.
 */
export function parseGraphDateValue(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new GraphExecutionError(
        "Date value is invalid",
        "GRAPH_DATA_INVALID_DATE",
        { value }
      );
    }
    return value;
  }
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    if (!Number.isNaN(fromNumber.getTime())) return fromNumber;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new GraphExecutionError(
    "Date & Time node requires a valid date value",
    "GRAPH_DATA_INVALID_DATE",
    { value }
  );
}

/**
 * Type guard for binary file payloads.
 *
 * @param value - The value to test.
 * @returns `true` for `Buffer`, `Uint8Array`, and `ArrayBuffer` values — the
 *   payload shapes the IO nodes decode into file content.
 */
export function isBinaryGraphDataPayload(
  value: unknown
): value is Buffer | Uint8Array | ArrayBuffer {
  return (
    typeof Buffer !== "undefined" && Buffer.isBuffer(value)
  ) || value instanceof Uint8Array || value instanceof ArrayBuffer;
}
