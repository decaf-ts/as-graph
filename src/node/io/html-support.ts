/**
 * @module as-graph/nodes/io/html-support
 * @summary HTML extraction, template rendering, and table helpers for the IO nodes.
 * @description Cheerio-based extraction supports text, HTML, attribute, and form
 * value returns, optional arrays for repeated matches, and selector-based
 * text cleanup with `html-to-text`. The module also flattens HTML documents out
 * of strings, arrays, buffers, and graph records, renders `{{path}}` templates,
 * and builds HTML tables with optional captions and attributes.
 */
import * as cheerio from "cheerio";
import { convert } from "html-to-text";
import { getGraphDataValue, isGraphDataRecord } from "../data/support";

/** What an extraction rule returns from the selected element(s). */
export type HtmlReturnValue = "attribute" | "html" | "text" | "value";

/** One CSS-selector extraction rule. */
export interface HtmlExtractionValue {
  key: string;
  cssSelector: string;
  returnValue?: HtmlReturnValue;
  attribute?: string;
  returnArray?: boolean;
  skipSelectors?: string;
}

/** Text post-processing options for extracted values. */
export interface HtmlExtractionOptions {
  trimValues?: boolean;
  cleanUpText?: boolean;
}

function applyTextOptions(
  value: string | undefined,
  options: HtmlExtractionOptions
): string | undefined {
  if (value === undefined) return value;
  let result = value;
  if (options.trimValues !== false) result = result.trim();
  if (options.cleanUpText) {
    result = result
      .replace(/^\s+|\s+$/g, "")
      .replace(/(\r\n|\n|\r)/gm, "")
      .replace(/\s+/g, " ");
  }
  return result;
}

function textOf(
  element: unknown,
  value: HtmlExtractionValue
): string | undefined {
  const entry = element as { text: () => string; html: () => string | null };
  if (!value.skipSelectors) return entry.text() || undefined;
  const selectors = value.skipSelectors
    .split(",")
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0)
    .map((selector) => ({ selector, format: "skip" as const }));
  return convert(entry.html() ?? "", { selectors } as any) || undefined;
}

function extractValue(
  element: unknown,
  value: HtmlExtractionValue,
  options: HtmlExtractionOptions
): unknown {
  const entry = element as {
    attr: (name: string) => string | undefined;
    html: () => string | null;
    val: () => string | string[] | undefined;
  };
  let result: string | undefined;
  switch (value.returnValue ?? "text") {
    case "attribute":
      result = value.attribute ? entry.attr(value.attribute) : undefined;
      break;
    case "html":
      result = entry.html() ?? undefined;
      break;
    case "value": {
      const raw = entry.val();
      result =
        raw === undefined ? undefined : Array.isArray(raw) ? raw.join(",") : raw;
      break;
    }
    case "text":
    default:
      result = textOf(element, value);
      break;
  }
  if (result === undefined) return undefined;
  return applyTextOptions(result, options);
}

/**
 * Applies extraction rules to an HTML document.
 *
 * @param html - The HTML document.
 * @param values - Extraction rules; entries without a `cssSelector` are skipped.
 * @param options - Text trimming/cleanup options.
 * @returns A record keyed by each rule's `key` (or its selector).
 */
export function extractHtmlValues(
  html: string,
  values: HtmlExtractionValue[],
  options: HtmlExtractionOptions = {}
): Record<string, unknown> {
  const $ = cheerio.load(html);
  const record: Record<string, unknown> = {};
  for (const value of values) {
    if (!value || typeof value.cssSelector !== "string") continue;
    const key = value.key || value.cssSelector;
    const selection = $(value.cssSelector);
    if (value.returnArray) {
      const entries: unknown[] = [];
      selection.each((_index: number, element: any) => {
        entries.push(extractValue($(element), value, options));
      });
      record[key] = entries;
    } else {
      record[key] = extractValue(selection, value, options);
    }
  }
  return record;
}

/**
 * Flattens a value into HTML document strings.
 *
 * Strings are used directly, arrays recurse, buffers/typed arrays/array
 * buffers decode as UTF-8, and records contribute the first of their `data`,
 * `content`, `html`, or `value` fields.
 *
 * @param value - The value to flatten.
 * @returns The HTML document strings (empty when none can be found).
 */
export function htmlDocumentOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => htmlDocumentOf(entry));
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return [Buffer.from(value).toString("utf8")];
  }
  if (value instanceof ArrayBuffer) {
    return [Buffer.from(new Uint8Array(value)).toString("utf8")];
  }
  if (isGraphDataRecord(value)) {
    for (const key of ["data", "content", "html", "value"]) {
      if (value[key] !== undefined && value[key] !== value) {
        return htmlDocumentOf(value[key]);
      }
    }
  }
  return [];
}

/**
 * Renders `{{path}}` placeholders against graph data.
 *
 * Paths are dot-addressed (an optional `$json.` prefix is dropped); missing
 * values render as an empty string and objects render as JSON.
 *
 * @param template - The template text.
 * @param data - The value used for placeholder lookup.
 * @returns The rendered template.
 */
export function renderHtmlTemplate(template: string, data: unknown): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath) => {
    const path = String(rawPath).replace(/^\$json\.?/, "").trim();
    const value = getGraphDataValue(data, path, true);
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

/** Rendering options for `graphDataToHtmlTable`. */
export interface HtmlTableOptions {
  caption?: string;
  tableAttributes?: string;
  headerAttributes?: string;
  rowAttributes?: string;
  cellAttributes?: string;
  customStyling?: boolean;
  capitalize?: boolean;
}

function capitalizeHeader(header: string, capitalize?: boolean): string {
  if (!capitalize) return header;
  return header
    .split("_")
    .filter((word) => word)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Builds an HTML table from item records.
 *
 * Headers are the union of the record keys; booleans render as checkboxes and
 * missing values as empty cells. Default inline styles are omitted when
 * `customStyling` is set, and `capitalize` humanizes headers.
 *
 * @param items - The items to render; non-records become `{ value }` rows.
 * @param options - Caption, attribute, styling, and header options.
 * @returns The HTML table markup.
 */
export function graphDataToHtmlTable(
  items: unknown[],
  options: HtmlTableOptions = {}
): string {
  const records = items.map((item) =>
    isGraphDataRecord(item) ? item : { value: item }
  );
  const headers = Array.from(
    new Set(records.flatMap((record) => Object.keys(record)))
  );
  const tableStyle = options.customStyling
    ? ""
    : "style='border-spacing:0; font-family:helvetica,arial,sans-serif'";
  const headerStyle = options.customStyling
    ? ""
    : "style='margin:0; padding:7px 20px 7px 0px; border-bottom:1px solid #eee; text-align:left; color:#888; font-weight:normal'";
  const cellStyle = options.customStyling
    ? ""
    : "style='margin:0; padding:7px 20px 7px 0px; border-bottom:1px solid #eee'";
  let table = `<table ${tableStyle} ${options.tableAttributes ?? ""}>`;
  if (options.caption) table += `<caption>${options.caption}</caption>`;
  table += `<thead ${headerStyle} ${options.headerAttributes ?? ""}>`;
  table += "<tr>";
  table += headers
    .map(
      (header) =>
        `<th>${capitalizeHeader(header, options.capitalize)}</th>`
    )
    .join("");
  table += "</tr></thead><tbody>";
  for (const record of records) {
    table += `<tr ${options.rowAttributes ?? ""}>`;
    table += headers
      .map((header) => {
        const value = record[header];
        let cell = `<td ${cellStyle} ${options.cellAttributes ?? ""}>`;
        if (typeof value === "boolean") {
          cell += `<input type="checkbox" ${
            value ? 'checked="checked"' : ""
          }/>`;
        } else {
          cell += value === undefined || value === null ? "" : String(value);
        }
        cell += "</td>";
        return cell;
      })
      .join("");
    table += "</tr>";
  }
  table += "</tbody></table>";
  return table;
}
