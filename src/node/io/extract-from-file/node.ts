/**
 * @module as-graph/nodes/io/extract-from-file
 * @summary Extract from File IO node declaration (DECAF-746 IO family).
 * @description Extract from File — decode a file payload and parse its
 * content. The `value` input may be a raw string, a data URL, a record with a
 * `data`/`content` string field, or a binary payload (`Buffer`, `Uint8Array`,
 * `ArrayBuffer`); base64 content is decoded per `encoding`. The decoded text
 * is then parsed per `format`: `json` via `JSON.parse`, `csv` through a
 * quote-aware delimited parser (configured `delimiter`, first row used as
 * header unless `headerRow` is disabled — then columns are named
 * `column0`, `column1`, …), or `text` verbatim. The `rows` output reports the
 * parsed row count for `csv`.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { isBinaryGraphDataPayload, isGraphDataRecord } from "../../data/support";

/** Content format the decoded file is parsed as. */
export type ExtractFromFileFormat = "json" | "csv" | "text";

/** Encoding of the incoming string payload. */
export type ExtractFromFileEncoding = "utf8" | "base64";

/** Inputs accepted by the Extract from File node. */
export type ExtractFromFileNodeInput = Record<string, unknown>;

/** Outputs produced by the Extract from File node. */
export interface ExtractFromFileNodeOutput {
  result: unknown;
  rows?: number;
}

/**
 * Decodes the incoming file payload into UTF-8 text.
 *
 * Strings that start with `data:` are treated as data URLs and their base64
 * body decoded regardless of `encoding`; record payloads are unwrapped from
 * their `data`/`content` field first.
 *
 * @param value - The raw input payload.
 * @param encoding - Encoding to apply to plain string payloads.
 * @returns The decoded UTF-8 content.
 * @throws {GraphExecutionError} with code `GRAPH_EXTRACT_FROM_FILE_INVALID_INPUT`
 *   when the payload is not a decodable string, record, or binary value.
 */
function decodeContent(value: unknown, encoding: ExtractFromFileEncoding): string {
  if (typeof value === "string") {
    if (value.startsWith("data:")) {
      const comma = value.indexOf(",");
      if (comma >= 0) {
        return Buffer.from(value.slice(comma + 1), "base64").toString("utf8");
      }
    }
    return encoding === "base64"
      ? Buffer.from(value, "base64").toString("utf8")
      : value;
  }
  if (isBinaryGraphDataPayload(value)) {
    const buffer = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    return buffer.toString("utf8");
  }
  if (isGraphDataRecord(value)) {
    if (typeof value["data"] === "string") {
      return decodeContent(value["data"], encoding);
    }
    if (typeof value["content"] === "string") {
      return decodeContent(value["content"], encoding);
    }
    throw new GraphExecutionError(
      "Extract from File node received an object without file content",
      "GRAPH_EXTRACT_FROM_FILE_INVALID_INPUT"
    );
  }
  throw new GraphExecutionError(
    "Extract from File node requires a file payload",
    "GRAPH_EXTRACT_FROM_FILE_INVALID_INPUT",
    { valueType: typeof value }
  );
}

/**
 * Splits delimited content into rows of fields.
 *
 * A minimal RFC 4180-style state machine: double quotes toggle quoting,
 * `""` inside quotes is a literal quote, the delimiter ends a field, and
 * newlines end rows (`\r` is ignored). Blank rows are filtered out.
 *
 * @param content - The decoded file content.
 * @param delimiter - The single-character field delimiter.
 * @returns The parsed rows of field values.
 */
function parseDelimitedRows(
  content: string,
  delimiter: string
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (quoted) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (character === "\r") continue;
    field += character;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(
    (entry) => entry.length > 1 || (entry[0] ?? "").trim().length > 0
  );
}

/**
 * Parses delimited content into records keyed by header.
 *
 * @param content - The decoded file content.
 * @param delimiter - The field delimiter.
 * @param headerRow - When true the first row supplies the header names;
 *   otherwise columns are named `column0`, `column1`, ….
 * @returns One record per data row; missing cells become empty strings.
 */
function parseCsv(
  content: string,
  delimiter: string,
  headerRow: boolean
): Record<string, string>[] {
  const rows = parseDelimitedRows(content, delimiter);
  if (rows.length === 0) return [];
  const header = headerRow ? rows[0] : rows[0].map((_, index) => `column${index}`);
  const dataRows = headerRow ? rows.slice(1) : rows;
  return dataRows.map((row) => {
    const record: Record<string, string> = {};
    for (let index = 0; index < header.length; index++) {
      record[header[index]] = row[index] ?? "";
    }
    return record;
  });
}

/**
 * Extract from File IO node: decodes a file payload and parses it as JSON,
 * CSV, or plain text.
 */
@node("core.io.extractFromFile", {
  kind: "core.io.extractFromFile",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-file-import",
  width: 96,
  height: 96,
  labels: ["io", "file", "extract"],
  metadata: {
    title: "graph.node.io.extract_from_file.name",
    description: "graph.node.io.extract_from_file.description",
  },
})
@model()
export class ExtractFromFileNode extends GraphNode<
  ExtractFromFileNodeInput,
  ExtractFromFileNodeOutput
> {
  /**
   * Decodes the input payload and parses it per the configured format.
   *
   * @param request - The execution request carrying the `value` payload.
   * @returns The parsed content under `result` (and the row count under
   *   `rows` for CSV).
   * @throws {GraphExecutionError} with code `GRAPH_EXTRACT_FROM_FILE_INVALID_JSON`
   *   when JSON parsing fails, `GRAPH_EXTRACT_FROM_FILE_UNSUPPORTED_FORMAT`
   *   for an unknown `format`, or `GRAPH_EXTRACT_FROM_FILE_INVALID_INPUT` when
   *   the payload cannot be decoded.
   */
  override execute(
    request: GraphNodeExecutionRequest<ExtractFromFileNodeInput>
  ): GraphExecutionValues {
    const content = decodeContent(
      request.inputs["value"],
      this.encoding ?? "utf8"
    );

    switch (this.format) {
      case "json":
        try {
          return { result: JSON.parse(content) };
        } catch (error) {
          throw new GraphExecutionError(
            `Extract from File node could not parse JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "GRAPH_EXTRACT_FROM_FILE_INVALID_JSON"
          );
        }
      case "csv": {
        const rows = parseCsv(
          content,
          this.delimiter || ",",
          this.headerRow !== false
        );
        return { result: rows, rows: rows.length };
      }
      case "text":
        return { result: content };
      default:
        throw new GraphExecutionError(
          `Unsupported file extraction format '${String(this.format)}'`,
          "GRAPH_EXTRACT_FROM_FILE_UNSUPPORTED_FORMAT",
          { format: this.format }
        );
    }
  }

  @required()
  @input({ handle: "value" })
  value!: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.extract_from_file.fields.format.label",
    type: "select",
  })
  @input({ handle: "format", userControlled: true })
  format: ExtractFromFileFormat = "json";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.extract_from_file.fields.encoding.label",
    type: "select",
  })
  @input({ handle: "encoding", userControlled: true })
  encoding: ExtractFromFileEncoding = "utf8";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.extract_from_file.fields.delimiter.label",
    type: "text",
  })
  @input({ handle: "delimiter", userControlled: true })
  delimiter?: string = ",";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.extract_from_file.fields.headerRow.label",
    type: "checkbox",
  })
  @input({ handle: "headerRow", userControlled: true })
  headerRow?: boolean = true;

  @required()
  @output({ handle: "result" })
  result!: unknown;

  @output({ handle: "rows" })
  rows?: number;
}
