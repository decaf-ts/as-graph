/**
 * @module as-graph/nodes/data/transform-utils
 * @description Shared data-transform primitives for the Stage 5a Data nodes
 * (`aggregate`, `itemLists`, `compareDatasets`, `summarize`, and
 * `removeDuplicates`). The module owns field-list normalization, stable value
 * signatures and equality, field path collection/projection, aggregation,
 * sorting, split-out, deduplication, and the summarize engine. It builds on the
 * path helpers in `./support` and throws `GraphExecutionError` with the
 * `GRAPH_*` codes documented per function. Field-derived write keys are passed
 * through `assertGraphDataSegment`, so a reserved segment fails closed with
 * `GRAPH_DATA_UNSAFE_PATH` instead of reaching the prototype chain.
 */
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
import {
  assertGraphDataSegment,
  compareGraphDataValues,
  deleteGraphDataValue,
  getGraphDataValue,
  isGraphDataRecord,
  setGraphDataValue,
} from "./support";

/** Field list accepted from node configuration: comma-separated text or an array of names. */
export type GraphFieldList = string | string[];

/**
 * Normalizes a configured field list into trimmed, non-empty names.
 *
 * @param value - Comma-separated string, string array, or nil.
 * @param fieldName - Label used in the validation error (default `Fields`).
 * @returns The normalized field names; an empty array for nil input.
 * @throws {GraphExecutionError} `GRAPH_DATA_INVALID_FIELDS` when the value is
 *   neither a string nor an array of strings.
 */
export function prepareGraphFields(
  value: unknown,
  fieldName = "Fields"
): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  throw new GraphExecutionError(
    `The '${fieldName}' parameter must be a comma-separated string or an array of strings`,
    "GRAPH_DATA_INVALID_FIELDS",
    { fieldName }
  );
}

/**
 * Converts a field path into an aggregation-key-safe name by removing
 * brackets/quotes and replacing spaces and dots with underscores.
 *
 * @param name - The raw field name.
 * @returns The normalized field name.
 */
export function normalizeGraphFieldName(name: string): string {
  return name.replace(/]/g, "").replace(/\[/g, "").replace(/"/g, "").replace(/[ .]/g, "_");
}

/**
 * Builds a deterministic JSON signature for a value, used for deduplication
 * and grouping.
 *
 * Object keys are sorted, dates become ISO strings, `NaN`, `undefined`, and
 * bigint values get explicit markers, and arrays/records are normalized
 * recursively so equal data always yields the same key.
 *
 * @param value - The value to serialize.
 * @returns The stable signature string.
 * @throws {GraphExecutionError} `GRAPH_DATA_UNSAFE_PATH` when a record key is
 *   a reserved prototype-pollution segment.
 */
export function stableGraphKey(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry instanceof Date) return entry.toISOString();
    if (isGraphDataRecord(entry)) {
      return Object.keys(entry)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          assertGraphDataSegment(key, key);
          result[key] = normalize(entry[key]);
          return result;
        }, {});
    }
    if (typeof entry === "number" && Number.isNaN(entry)) return "@NaN";
    if (entry === undefined) return "@undefined";
    if (typeof entry === "bigint") return `${entry.toString()}n`;
    return entry;
  };
  return JSON.stringify(normalize(value));
}

/**
 * Strict deep equality for graph data.
 *
 * Values compare by identity, `NaN` equals `NaN`, dates compare by timestamp,
 * and arrays/records compare recursively with matching keys and lengths.
 *
 * @param left - First value.
 * @param right - Second value.
 * @returns `true` when both values are deeply equal.
 */
export function graphValueEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    typeof left === "number" &&
    typeof right === "number" &&
    Number.isNaN(left) &&
    Number.isNaN(right)
  ) {
    return true;
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((entry, index) => graphValueEquals(entry, right[index]));
  }
  if (isGraphDataRecord(left) && isGraphDataRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        graphValueEquals(left[key], right[key])
    );
  }
  return false;
}

function isFalsyCompareValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false) {
    return true;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (isGraphDataRecord(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * Fuzzy equality used by the Compare Datasets node when `fuzzyCompare` is on.
 *
 * Besides strict equality it treats empty values (`null`, `undefined`, `""`,
 * `false`, empty arrays/records) as equivalent, compares numeric strings to
 * numbers, and parses JSON strings before comparing them to records.
 *
 * @param left - First value.
 * @param right - Second value.
 * @returns `true` when the values are loosely equivalent.
 */
export function graphValuesLooselyEqual(
  left: unknown,
  right: unknown
): boolean {
  if (left !== null && right !== null && typeof left === typeof right) {
    return graphValueEquals(left, right);
  }
  if (isFalsyCompareValue(left) && isFalsyCompareValue(right)) return true;
  if (isFalsyCompareValue(left) && right === undefined) return true;
  if (left === undefined && isFalsyCompareValue(right)) return true;
  if (typeof left === "number" && typeof right === "string") {
    return left.toString() === right;
  }
  if (typeof left === "string" && typeof right === "number") {
    return left === right.toString();
  }
  if (isGraphDataRecord(left) && typeof right === "string") {
    try {
      return graphValueEquals(left, JSON.parse(right));
    } catch {
      return false;
    }
  }
  if (typeof left === "string" && isGraphDataRecord(right)) {
    try {
      return graphValueEquals(JSON.parse(left), right);
    } catch {
      return false;
    }
  }
  return graphValueEquals(left, right);
}

/**
 * Collects the leaf field paths of a value using dot notation or flat keys.
 *
 * Nested records recurse; arrays and scalars produce the current path. An
 * empty record yields its own path (or no path at the root).
 *
 * @param value - The value to inspect.
 * @param dotNotation - Whether nested records produce dot-separated paths.
 * @param prefix - Accumulated path segments (used by recursion).
 * @returns The collected field paths.
 */
export function collectGraphFieldPaths(
  value: unknown,
  dotNotation: boolean,
  prefix: string[] = []
): string[] {
  if (!isGraphDataRecord(value) || Array.isArray(value)) {
    return prefix.length ? [prefix.join(".")] : [];
  }
  if (!dotNotation) {
    return prefix.length ? [prefix.join(".")] : Object.keys(value);
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return prefix.length ? [prefix.join(".")] : [];
  }
  const paths: string[] = [];
  for (const key of keys) {
    const child = value[key];
    if (isGraphDataRecord(child) && !Array.isArray(child)) {
      const childPaths = collectGraphFieldPaths(child, dotNotation, [
        ...prefix,
        key,
      ]);
      if (childPaths.length === 0) {
        paths.push([...prefix, key].join("."));
      } else {
        paths.push(...childPaths);
      }
    } else {
      paths.push([...prefix, key].join("."));
    }
  }
  return paths;
}

/**
 * Returns a shallow copy of a record without the configured fields.
 *
 * @param value - The source value; non-records are returned unchanged.
 * @param fields - Field paths to remove.
 * @param dotNotation - Whether field paths use dot notation.
 * @returns The record without the omitted fields.
 */
export function omitGraphFields(
  value: unknown,
  fields: string[],
  dotNotation: boolean
): unknown {
  if (!isGraphDataRecord(value) || Array.isArray(value)) return value;
  const result: Record<string, unknown> = { ...value };
  for (const field of fields) {
    if (!field) continue;
    deleteGraphDataValue(result, field, dotNotation);
  }
  return result;
}

/**
 * Builds a record containing only the requested field paths.
 *
 * @param value - The source value; non-records are returned unchanged.
 * @param fields - Field paths to keep.
 * @param dotNotation - Whether field paths use dot notation.
 * @returns The projected record.
 */
export function projectGraphRecord(
  value: unknown,
  fields: string[],
  dotNotation: boolean
): unknown {
  if (!isGraphDataRecord(value) || Array.isArray(value)) return value;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const selected = getGraphDataValue(value, field, dotNotation);
    setGraphDataValue(result, field, selected, dotNotation);
  }
  return result;
}

/** Configuration for one aggregated source field. */
export interface AggregateFieldSpec {
  field?: string;
  fieldToAggregate?: string;
  renameField?: boolean;
  outputFieldName?: string;
}

/** Options controlling `aggregateGraphItems` path and missing-value handling. */
export interface AggregateOptions {
  dotNotation?: boolean;
  mergeLists?: boolean;
  keepMissing?: boolean;
}

function aggregateOutputName(
  source: string,
  spec: AggregateFieldSpec,
  dotNotation: boolean
): string {
  if (spec.outputFieldName) return spec.outputFieldName;
  if (dotNotation && source.includes(".")) {
    return source.split(".").pop() ?? source;
  }
  return source;
}

/**
 * Aggregates one output list of values per configured source field.
 *
 * Array values are flattened when `mergeLists` is set; `null`/`undefined`
 * values are skipped unless `keepMissing` is set. Duplicate output names are
 * rejected so no field is silently overwritten.
 *
 * @param items - The items to aggregate.
 * @param fields - Source fields and their output options.
 * @param options - Path, list-merging, and missing-value options.
 * @returns A record keyed by output field name.
 * @throws {GraphExecutionError} `GRAPH_AGGREGATE_DUPLICATE_FIELD` when two
 *   specs map to the same output field, or `GRAPH_DATA_UNSAFE_PATH` when an
 *   output field is a reserved prototype-pollution segment.
 */
export function aggregateGraphItems(
  items: unknown[],
  fields: AggregateFieldSpec[],
  options: AggregateOptions = {}
): Record<string, unknown> {
  const dotNotation = options.dotNotation !== false;
  const result: Record<string, unknown> = {};
  const used = new Set<string>();
  for (const spec of fields) {
    const source = spec?.field ?? spec?.fieldToAggregate;
    if (!source) continue;
    const output = aggregateOutputName(source, spec, dotNotation);
    if (used.has(output)) {
      throw new GraphExecutionError(
        `The '${output}' output field is used more than once`,
        "GRAPH_AGGREGATE_DUPLICATE_FIELD",
        { field: output }
      );
    }
    used.add(output);
    const values: unknown[] = [];
    for (const item of items) {
      let value = getGraphDataValue(item, source, dotNotation);
      if (Array.isArray(value) && !options.keepMissing) {
        value = value.filter((entry) => entry !== null && entry !== undefined);
      } else if (
        !options.keepMissing &&
        (value === undefined || value === null)
      ) {
        continue;
      }
      if (Array.isArray(value) && options.mergeLists) {
        values.push(...value);
      } else {
        values.push(value);
      }
    }
    setGraphDataValue(result, output, values, dotNotation);
  }
  return result;
}

/** Field projection options for `aggregateGraphItemData`. */
export interface AggregateAllOptions {
  include?: "allFields" | "specifiedFields" | "allFieldsExcept";
  fieldsToInclude?: string[];
  fieldsToExclude?: string[];
}

/**
 * Groups every item into a projected record, dropping empty projections.
 *
 * @param items - The items to collect.
 * @param options - Projection mode and the include/exclude field lists.
 * @returns The projected item records.
 * @throws {GraphExecutionError} `GRAPH_DATA_UNSAFE_PATH` when a projected key
 *   is a reserved prototype-pollution segment.
 */
export function aggregateGraphItemData(
  items: unknown[],
  options: AggregateAllOptions = {}
): Array<Record<string, unknown>> {
  const include = options.include ?? "allFields";
  const fieldsToInclude = options.fieldsToInclude ?? [];
  const fieldsToExclude = options.fieldsToExclude ?? [];
  const records: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const record: Record<string, unknown> = isGraphDataRecord(item)
      ? { ...item }
      : item === undefined
        ? {}
        : { value: item };
    const keys = Object.keys(record);
    let selected = keys;
    if (include === "specifiedFields") {
      selected = keys.filter((key) => fieldsToInclude.includes(key));
    } else if (include === "allFieldsExcept") {
      selected = keys.filter((key) => !fieldsToExclude.includes(key));
    }
    const projected: Record<string, unknown> = {};
    for (const key of selected) {
      assertGraphDataSegment(key, key);
      projected[key] = record[key];
    }
    if (Object.keys(projected).length > 0) records.push(projected);
  }
  return records;
}

/** One sort key and its direction. */
export interface SortSpec {
  field: string;
  direction?: "asc" | "desc";
}

/**
 * Returns a sorted copy of the items using the configured keys.
 *
 * Keys apply in order; the first non-zero comparison wins and `desc` reverses
 * that key's comparison. An empty usable field list returns the input order.
 *
 * @param items - The items to sort.
 * @param fields - Sort keys and directions.
 * @param dotNotation - Whether field paths use dot notation.
 * @param valueType - Coercion used for comparisons (default `auto`).
 * @returns The sorted items.
 */
export function sortGraphItems(
  items: unknown[],
  fields: SortSpec[],
  dotNotation: boolean,
  valueType: "auto" | "string" | "number" | "date" = "auto"
): unknown[] {
  const sorted = [...items];
  const usable = fields.filter(
    (entry) => entry && typeof entry.field === "string"
  );
  if (usable.length === 0) return sorted;
  sorted.sort((left, right) => {
    for (const entry of usable) {
      const comparison = compareGraphDataValues(
        getGraphDataValue(left, entry.field, dotNotation),
        getGraphDataValue(right, entry.field, dotNotation),
        valueType
      );
      if (comparison !== 0) {
        return entry.direction === "desc" ? -comparison : comparison;
      }
    }
    return 0;
  });
  return sorted;
}

/** Options for `splitGraphOutItems`. */
export interface SplitOutOptions {
  include?: "noOtherFields" | "allOtherFields";
  destinationField?: string;
  dotNotation?: boolean;
}

/**
 * Expands an array-valued field into one output item per value.
 *
 * Missing values are skipped. With `include: "allOtherFields"` each output
 * keeps the other item fields and receives the value under `destinationField`
 * (defaults to the split field).
 *
 * @param items - The items to split.
 * @param field - The array-valued field path.
 * @param options - Field retention and destination options.
 * @returns The split-out items.
 */
export function splitGraphOutItems(
  items: unknown[],
  field: string,
  options: SplitOutOptions = {}
): unknown[] {
  const dotNotation = options.dotNotation !== false;
  const result: unknown[] = [];
  for (const item of items) {
    const value = getGraphDataValue(item, field, dotNotation);
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (entry === undefined || entry === null) continue;
      if (options.include !== "allOtherFields") {
        result.push(entry);
        continue;
      }
      const destination = options.destinationField || field;
      const base: Record<string, unknown> = isGraphDataRecord(item)
        ? { ...item }
        : {};
      deleteGraphDataValue(base, field, true);
      setGraphDataValue(base, destination, entry, true);
      result.push(base);
    }
  }
  return result;
}

/** Field selection used for duplicate comparison. */
export type CompareMode = "allFields" | "allFieldsExcept" | "selectedFields";

/** Options for `dedupeGraphItems`. */
export interface DedupeOptions {
  compare?: CompareMode;
  fieldsToExclude?: GraphFieldList;
  fieldsToCompare?: GraphFieldList;
  removeOtherFields?: boolean;
  dotNotation?: boolean;
}

/** Unique and discarded items produced by `dedupeGraphItems`. */
export interface DedupeResult {
  kept: unknown[];
  discarded: unknown[];
}

/**
 * Keeps the first item of each comparison signature.
 *
 * Signatures are built from every field, every field except the excluded
 * list, or the selected field list. `removeOtherFields` projects kept items
 * onto the compared fields.
 *
 * @param items - The items to deduplicate.
 * @param options - Comparison mode, field lists, and projection option.
 * @returns The unique items and the duplicates removed.
 * @throws {GraphExecutionError} `GRAPH_REMOVE_DUPLICATES_FIELDS_REQUIRED` when
 *   the chosen mode has no field list, or
 *   `GRAPH_REMOVE_DUPLICATES_FIELD_MISSING` when selected fields are absent
 *   from every item.
 */
export function dedupeGraphItems(
  items: unknown[],
  options: DedupeOptions = {}
): DedupeResult {
  const dotNotation = options.dotNotation !== false;
  const compare = options.compare ?? "allFields";
  let keys: string[];

  if (compare === "selectedFields") {
    keys = prepareGraphFields(
      options.fieldsToCompare,
      "Fields To Compare"
    );
    if (keys.length === 0) {
      throw new GraphExecutionError(
        "No fields specified to compare on",
        "GRAPH_REMOVE_DUPLICATES_FIELDS_REQUIRED"
      );
    }
    const found = items.some((item) =>
      keys.some(
        (key) => getGraphDataValue(item, key, dotNotation) !== undefined
      )
    );
    if (!found) {
      throw new GraphExecutionError(
        `The fields '${keys.join(", ")}' are not present in any input item`,
        "GRAPH_REMOVE_DUPLICATES_FIELD_MISSING",
        { fields: keys }
      );
    }
  } else if (compare === "allFieldsExcept") {
    const excluded = prepareGraphFields(
      options.fieldsToExclude,
      "Fields To Exclude"
    );
    if (excluded.length === 0) {
      throw new GraphExecutionError(
        "No fields specified to exclude from comparison",
        "GRAPH_REMOVE_DUPLICATES_FIELDS_REQUIRED"
      );
    }
    const all = new Set<string>();
    for (const item of items) {
      for (const key of collectGraphFieldPaths(item, dotNotation)) {
        all.add(key);
      }
    }
    keys = Array.from(all).filter((key) => !excluded.includes(key));
  } else {
    const all = new Set<string>();
    for (const item of items) {
      for (const key of collectGraphFieldPaths(item, dotNotation)) {
        all.add(key);
      }
    }
    keys = Array.from(all);
  }

  const kept: unknown[] = [];
  const discarded: unknown[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const signature = isGraphDataRecord(item)
      ? stableGraphKey(
          keys.map((key) => getGraphDataValue(item, key, dotNotation))
        )
      : stableGraphKey(item);
    if (seen.has(signature)) {
      discarded.push(item);
      continue;
    }
    seen.add(signature);
    kept.push(
      options.removeOtherFields
        ? projectGraphRecord(item, keys, dotNotation)
        : item
    );
  }
  return { kept, discarded };
}

/** Aggregations supported by the summarize engine. */
export type SummarizeAggregation =
  | "append"
  | "average"
  | "concatenate"
  | "count"
  | "countUnique"
  | "max"
  | "min"
  | "sum";

/** One summarize aggregation applied to a field. */
export interface SummarizeField {
  aggregation: SummarizeAggregation;
  field?: string;
  includeEmpty?: boolean;
  separator?: string;
  customSeparator?: string;
}

/** Options for `summarizeGraphItems`. */
export interface SummarizeOptions {
  fieldsToSplitBy?: GraphFieldList;
  outputFormat?: "separateItems" | "singleItem";
  skipEmptySplitFields?: boolean;
  dotNotation?: boolean;
  continueIfFieldNotFound?: boolean;
}

const AGGREGATION_PREFIXES: Record<SummarizeAggregation, string> = {
  append: "appended_",
  average: "average_",
  concatenate: "concatenated_",
  count: "count_",
  countUnique: "unique_count_",
  max: "max_",
  min: "min_",
  sum: "sum_",
};

function summarizeIsEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function summarizeAggregate(
  items: unknown[],
  entry: SummarizeField,
  dotNotation: boolean
): unknown {
  const field = entry.field ?? "";
  const read = (item: unknown) =>
    field ? getGraphDataValue(item, field, dotNotation) : item;
  const values = items.map(read);
  const nonEmpty = entry.includeEmpty
    ? values
    : values.filter((value) => !summarizeIsEmpty(value));

  switch (entry.aggregation) {
    case "append":
      return nonEmpty;
    case "concatenate": {
      const separator =
        entry.separator === "other"
          ? (entry.customSeparator ?? "")
          : (entry.separator ?? ",");
      return nonEmpty
        .map((value) => {
          if (value === undefined) return "undefined";
          if (typeof value === "object") return JSON.stringify(value);
          return String(value);
        })
        .join(separator);
    }
    case "average": {
      const numbers = nonEmpty.filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value)
      );
      if (numbers.length === 0) return null;
      return numbers.reduce((total, value) => total + value, 0) / numbers.length;
    }
    case "sum": {
      return nonEmpty
        .filter(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value)
        )
        .reduce((total, value) => total + value, 0);
    }
    case "min": {
      let minimum: unknown;
      for (const value of nonEmpty) {
        if (value === undefined || value === null || value === "") continue;
        if (
          minimum === undefined ||
          (value as never) < (minimum as never)
        ) {
          minimum = value;
        }
      }
      return minimum ?? null;
    }
    case "max": {
      let maximum: unknown;
      for (const value of nonEmpty) {
        if (value === undefined || value === null || value === "") continue;
        if (
          maximum === undefined ||
          (value as never) > (maximum as never)
        ) {
          maximum = value;
        }
      }
      return maximum ?? null;
    }
    case "countUnique":
      return new Set(nonEmpty.map((value) => stableGraphKey(value))).size;
    case "count":
    default:
      return nonEmpty.length;
  }
}

function summarizeRecords(
  items: unknown[],
  aggregations: SummarizeField[],
  dotNotation: boolean
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const entry of aggregations) {
    const field = entry.field ?? "";
    const key = normalizeGraphFieldName(
      `${AGGREGATION_PREFIXES[entry.aggregation] ?? "count_"}${field}`
    );
    assertGraphDataSegment(key, key);
    record[key] = summarizeAggregate(items, entry, dotNotation);
  }
  return record;
}

interface SummarizeGroup {
  field: string;
  value: unknown;
  items?: unknown[];
  children?: SummarizeGroup[];
}

function summarizeGroupKey(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return stableGraphKey(value);
}

function buildSummarizeGroups(
  items: unknown[],
  fields: string[],
  index: number,
  dotNotation: boolean,
  skipEmpty: boolean
): SummarizeGroup[] {
  if (index >= fields.length) return [];
  const field = fields[index];
  const groups = new Map<string, { value: unknown; items: unknown[] }>();
  for (const item of items) {
    let value = getGraphDataValue(item, field, dotNotation);
    if (value && typeof value === "object") value = JSON.stringify(value);
    if (skipEmpty && typeof value !== "number" && !value) continue;
    const key = stableGraphKey(value);
    const group = groups.get(key) ?? { value, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const last = index === fields.length - 1;
  return Array.from(groups.values()).map((group) => ({
    field,
    value: group.value,
    ...(last
      ? { items: group.items }
      : {
          children: buildSummarizeGroups(
            group.items,
            fields,
            index + 1,
            dotNotation,
            skipEmpty
          ),
        }),
  }));
}

/**
 * Summarizes items by zero or more split fields.
 *
 * With no split fields it returns a single record. Otherwise it builds nested
 * groups and emits either one record per leaf group (`separateItems`) or one
 * nested record (`singleItem`). Unless `continueIfFieldNotFound` is set, a
 * referenced field that is absent from every item fails the node.
 *
 * @param items - The items to summarize.
 * @param aggregations - Aggregations to compute per group.
 * @param options - Split fields, output format, empty-field and path options.
 * @returns The summary records.
 * @throws {GraphExecutionError} `GRAPH_SUMMARIZE_FIELD_NOT_FOUND` when a
 *   referenced field is absent from every item, or `GRAPH_DATA_UNSAFE_PATH`
 *   when a field-derived output or grouping key is a reserved
 *   prototype-pollution segment.
 */
export function summarizeGraphItems(
  items: unknown[],
  aggregations: SummarizeField[],
  options: SummarizeOptions = {}
): Record<string, unknown>[] {
  const dotNotation = options.dotNotation !== false;
  const splitFields = prepareGraphFields(
    options.fieldsToSplitBy,
    "Fields To Split By"
  );
  const outputFormat = options.outputFormat ?? "separateItems";

  if (!options.continueIfFieldNotFound) {
    for (const entry of aggregations) {
      const field = entry.field ?? "";
      if (!field) continue;
      const found = items.some(
        (item) => getGraphDataValue(item, field, dotNotation) !== undefined
      );
      if (!found) {
        throw new GraphExecutionError(
          `The field '${field}' does not exist in any items`,
          "GRAPH_SUMMARIZE_FIELD_NOT_FOUND",
          { field }
        );
      }
    }
  }

  if (splitFields.length === 0) {
    return [summarizeRecords(items, aggregations, dotNotation)];
  }

  const groups = buildSummarizeGroups(
    items,
    splitFields,
    splitFields.length > 0 ? 0 : -1,
    dotNotation,
    options.skipEmptySplitFields === true
  );

  if (outputFormat === "singleItem") {
    const record = summarizeRecords(items, aggregations, dotNotation);
    const nest = (
      entries: SummarizeGroup[],
      target: Record<string, unknown>
    ) => {
      for (const entry of entries) {
        const fieldKey = normalizeGraphFieldName(entry.field);
        assertGraphDataSegment(fieldKey, fieldKey);
        const byValue =
          (target[fieldKey] as Record<string, unknown> | undefined) ?? {};
        target[fieldKey] = byValue;
        const valueKey = summarizeGroupKey(entry.value);
        assertGraphDataSegment(valueKey, valueKey);
        if (entry.children && entry.children.length > 0) {
          const child =
            (byValue[valueKey] as Record<string, unknown> | undefined) ?? {};
          byValue[valueKey] = child;
          nest(entry.children, child);
        } else if (entry.items) {
          byValue[valueKey] = summarizeRecords(
            entry.items,
            aggregations,
            dotNotation
          );
        }
      }
    };
    nest(groups, record);
    return [record];
  }

  const result: Record<string, unknown>[] = [];
  const walk = (
    entries: SummarizeGroup[],
    fieldPrefix: string[],
    valuePrefix: unknown[]
  ) => {
    for (const entry of entries) {
      const fields = [...fieldPrefix, entry.field];
      const values = [...valuePrefix, entry.value];
      if (entry.children && entry.children.length > 0) {
        walk(entry.children, fields, values);
      } else if (entry.items) {
        const record = summarizeRecords(
          entry.items,
          aggregations,
          dotNotation
        );
        fields.forEach((field, index) => {
          const key = normalizeGraphFieldName(field);
          assertGraphDataSegment(key, key);
          record[key] = values[index];
        });
        result.push(record);
      }
    }
  };
  walk(groups, [], []);
  return result;
}
