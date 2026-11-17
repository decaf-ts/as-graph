/**
 * @module as-graph/nodes/io/spreadsheet-file
 * @summary Spreadsheet File IO node declaration (Stage 3b; `core.io.spreadsheetFile`).
 * @description Spreadsheet File — n8n's Spreadsheet File node: read a
 * spreadsheet file into rows, or write rows into a spreadsheet file.
 *
 * `parse` reads the `value` input — a binary file payload (what Read Binary
 * File, Read/Write Files from Disk or an HTTP `file` response produce) or
 * plain text — falling back to the `content` field. CSV/TSV/JSON go through
 * the Decaf `SpreadsheetService`; XLSX/ODS through the `WorkbookService`. With
 * no `format`, a file payload's media type picks it (a workbook type selects
 * XLSX/ODS, anything else is text). The parsed rows land in the data
 * (`result`, `rows`, `header`); the file itself is not re-emitted.
 *
 * `write` takes `rows` — arrays of cells, or records whose keys form the
 * header — (falling back to the `value` input) and an optional `header`, and
 * emits a binary file payload (`csv`, `tsv`, `json`, `xlsx`, `ods`, `xls`)
 * named `fileName`, so the file shows on the binary tab and only a reference
 * travels between nodes. An unknown `operation` falls back to `parse`.
 */
import { model, option } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import {
  SpreadsheetService,
  WorkbookService,
  type SpreadsheetFormat,
  type WorkbookFormat,
} from "@decaf-ts/integrations/io/spreadsheet";
import { asStringArray } from "../../storage/support";
import { isGraphDataRecord } from "../../data/support";
import {
  binaryBufferOf,
  binaryPayloadOf,
  isBinaryFilePayload,
  type BinaryFilePayload,
} from "../file-support";

/** Operations the node can run (read a file into rows, or write rows into a file). */
export type SpreadsheetFileOperation = "parse" | "write";

/** Spreadsheet formats: text formats through `SpreadsheetService`, workbooks through `WorkbookService`. */
export type SpreadsheetFileFormat = SpreadsheetFormat | WorkbookFormat;

/** Inputs accepted by the Spreadsheet File node (the optional `value` input feeds `parse` content or `write` rows). */
export type SpreadsheetFileNodeInput = Record<string, unknown>;

/** Outputs produced by the Spreadsheet File node. */
export interface SpreadsheetFileNodeOutput {
  /** Parsed sheet (`parse`) or the written file payload (`write`). */
  result: unknown;
  /** Parsed data rows (`parse`). */
  rows?: unknown[][];
  /** Parsed header (`parse`). */
  header?: string[];
  /** Size of the written file (`write`). */
  bytes?: number;
}

/** All supported operations; unknown configured values fall back to `parse`. */
const OPERATIONS: SpreadsheetFileOperation[] = ["parse", "write"];

/** Media type and extension of each format the node writes. */
const FORMAT_FILES: Record<SpreadsheetFileFormat, { mimeType: string; extension: string }> = {
  csv: { mimeType: "text/csv", extension: "csv" },
  tsv: { mimeType: "text/tab-separated-values", extension: "tsv" },
  json: { mimeType: "application/json", extension: "json" },
  xlsx: {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  },
  ods: { mimeType: "application/vnd.oasis.opendocument.spreadsheet", extension: "ods" },
  xls: { mimeType: "application/vnd.ms-excel", extension: "xls" },
};

/**
 * Whether a format is a binary workbook package.
 * @returns {boolean} Whether the format is XLSX, ODS or XLS.
 */
function isWorkbookFormat(format: SpreadsheetFileFormat | undefined): format is WorkbookFormat {
  return format === "xlsx" || format === "ods" || format === "xls";
}

/** Picks the parse format of a file payload from its media type or extension. */
function formatOfPayload(payload: BinaryFilePayload): SpreadsheetFileFormat | undefined {
  const name = payload.fileName?.toLowerCase() ?? "";
  for (const [format, file] of Object.entries(FORMAT_FILES)) {
    if (payload.mimeType === file.mimeType || name.endsWith(`.${file.extension}`)) {
      return format as SpreadsheetFileFormat;
    }
  }
  return undefined;
}

/** Turns records into a header (first-seen key order) and cell rows. */
function tableOfRecords(records: Record<string, unknown>[]): {
  header: string[];
  rows: unknown[][];
} {
  const header: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        header.push(key);
      }
    }
  }
  return { header, rows: records.map((record) => header.map((key) => record[key])) };
}

/**
 * Spreadsheet File IO node: reads spreadsheet files into rows and writes rows
 * into spreadsheet files (CSV/TSV/JSON/XLSX/ODS, plus XLS on write).
 */
@node("core.io.spreadsheetFile", {
  kind: "core.io.spreadsheetFile",
  category: "IO",
  color: "#217346",
  icon: "ti-file-spreadsheet",
  width: 96,
  height: 96,
  labels: ["io", "spreadsheet", "csv", "tsv", "json", "xlsx", "ods", "xls"],
  metadata: {
    title: "graph.node.io.spreadsheet_file.name",
    description: "graph.node.io.spreadsheet_file.description",
  },
})
@model()
export class SpreadsheetFileNode extends GraphNode<
  SpreadsheetFileNodeInput,
  SpreadsheetFileNodeOutput
> {
  /**
   * Default data input: what the previous node produced — the file (or text)
   * to parse, or the rows to write when the matching field is empty.
   */
  @input({ handle: "value" })
  value?: unknown;

  /** Shared, stateless spreadsheet services reused across executions of this node instance. */
  private readonly spreadsheets = new SpreadsheetService();
  private readonly workbooks = new WorkbookService();

  /**
   * Executes the configured spreadsheet operation.
   *
   * @param request - Execution request whose optional `value` input feeds `parse` content or `write` rows.
   * @returns For `parse`: the parsed sheet on `result` plus `rows` and `header`; for `write`: the file payload on `result` and its size on `bytes`.
   * @throws {GraphExecutionError} with code `GRAPH_SPREADSHEET_CONTENT_REQUIRED` when `parse` has no file or text, `GRAPH_SPREADSHEET_UNSUPPORTED_FORMAT` when `parse` targets XLS, `GRAPH_SPREADSHEET_ROWS_REQUIRED` when `write` has no rows, or `GRAPH_SPREADSHEET_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<SpreadsheetFileNodeInput>
  ): Promise<GraphExecutionValues> {
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "parse";
    try {
      return operation === "parse"
        ? this.parse(request.inputs["value"])
        : this.write(request.inputs["value"]);
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Spreadsheet File node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_SPREADSHEET_OPERATION_FAILED",
        { operation }
      );
    }
  }

  /** Reads a file payload or text into the parsed sheet. */
  private parse(value: unknown): GraphExecutionValues {
    const source = this.content ?? value;
    const file = isBinaryFilePayload(source) ? source : undefined;
    const format = this.format ?? (file ? formatOfPayload(file) : undefined);
    if (format === "xls") {
      throw new GraphExecutionError(
        "Spreadsheet File cannot read XLS files; convert them to XLSX or ODS",
        "GRAPH_SPREADSHEET_UNSUPPORTED_FORMAT",
        { format }
      );
    }
    if (format === "xlsx" || format === "ods") {
      if (!file && !(source instanceof Uint8Array)) {
        throw new GraphExecutionError(
          `Spreadsheet File parse of ${format} requires a file`,
          "GRAPH_SPREADSHEET_CONTENT_REQUIRED",
          { format }
        );
      }
      const sheet = this.workbooks.read(binaryBufferOf(source, "base64"), {
        format,
        header: this.hasHeader,
        sheetName: this.sheetName || undefined,
      });
      return { result: sheet, rows: sheet.rows, header: sheet.header };
    }
    const text = file
      ? binaryBufferOf(file, "base64").toString("utf8")
      : typeof source === "string"
        ? source
        : undefined;
    if (text === undefined) {
      throw new GraphExecutionError(
        "Spreadsheet File parse requires a file or text content",
        "GRAPH_SPREADSHEET_CONTENT_REQUIRED"
      );
    }
    const result = this.spreadsheets.parse(text, {
      format,
      delimiter: this.delimiter,
      header: this.hasHeader,
    });
    return { result, rows: result.rows, header: result.header };
  }

  /** Serializes rows into a spreadsheet file payload. */
  private write(value: unknown): GraphExecutionValues {
    const source = Array.isArray(this.rows)
      ? this.rows
      : Array.isArray(value)
        ? (value as unknown[])
        : undefined;
    if (!source) {
      throw new GraphExecutionError(
        "Spreadsheet File write requires rows (arrays of cells or records)",
        "GRAPH_SPREADSHEET_ROWS_REQUIRED"
      );
    }
    const configuredHeader = asStringArray(this.header)?.map(String);
    const table =
      source.length > 0 && source.every((row) => isGraphDataRecord(row))
        ? tableOfRecords(source as Record<string, unknown>[])
        : { header: undefined, rows: source as unknown[][] };
    if (!table.rows.every((row) => Array.isArray(row))) {
      throw new GraphExecutionError(
        "Spreadsheet File write requires rows (arrays of cells or records)",
        "GRAPH_SPREADSHEET_ROWS_REQUIRED"
      );
    }
    const header = configuredHeader ?? table.header;
    const format: SpreadsheetFileFormat = this.format ?? "csv";
    const target = FORMAT_FILES[format] ?? FORMAT_FILES.csv;
    const bytes = isWorkbookFormat(format)
      ? Buffer.from(
          this.workbooks.write(table.rows, {
            format,
            header,
            sheetName: this.sheetName || undefined,
          })
        )
      : Buffer.from(
          this.spreadsheets.serialize(table.rows, {
            format,
            delimiter: this.delimiter,
            header,
          }),
          "utf8"
        );
    const fileName = this.fileName?.trim() || `spreadsheet.${target.extension}`;
    const payload = binaryPayloadOf(bytes, fileName, undefined, target.mimeType);
    return { result: payload, bytes: payload.byteLength };
  }

  /** Operation to run (default `parse`). */
  @option(["parse", "write"])
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: SpreadsheetFileOperation = "parse";

  /**
   * File format. `parse` infers it from a file's media type when unset; `write`
   * defaults to CSV. XLS is write-only.
   */
  @option(["csv", "json", "tsv", "xlsx", "ods", "xls"])
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.format.label",
    type: "select",
  })
  @input({ handle: "format", userControlled: true })
  format?: SpreadsheetFileFormat;

  /** Optional field delimiter override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.delimiter.label",
    type: "string",
  })
  @input({ handle: "delimiter", userControlled: true })
  delimiter?: string;

  /** Text parsed by `parse` instead of the `value` input's file. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.content.label",
    type: "textarea",
  })
  @input({ handle: "content", userControlled: true })
  content?: string;

  /** Rows serialized by `write` (falls back to the `value` input). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.rows.label",
    type: "json",
  })
  @input({ handle: "rows", userControlled: true })
  rows?: unknown[][];

  /** Optional header row emitted by `write`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.header.label",
    type: "json",
  })
  @input({ handle: "header", userControlled: true })
  header?: string[];

  /** Sheet read by `parse` (first sheet when empty) or named by `write`, for workbooks. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.sheetName.label",
    type: "text",
  })
  @input({ handle: "sheetName", userControlled: true })
  sheetName?: string;

  /** File name of the file `write` produces (default `spreadsheet.<extension>`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.fileName.label",
    placeholder: "graph.node.io.spreadsheet_file.fields.fileName.placeholder",
    type: "text",
  })
  @input({ handle: "fileName", userControlled: true })
  fileName?: string;

  /** Whether `parse` should treat the first row as a header. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.hasHeader.label",
    type: "boolean",
  })
  @input({ handle: "hasHeader", userControlled: true })
  hasHeader?: boolean;

  /** Parsed sheet (`parse`) or the written file payload (`write`). */
  @output({ handle: "result" })
  result!: unknown;

  /** Parsed rows emitted by `parse`. */
  @output({ handle: "rows", type: "array" })
  outputRows?: unknown[][];

  /** Parsed header emitted by `parse`. */
  @output({ handle: "header", type: "array" })
  outputHeader?: string[];

  /** Size of the file written by `write`. */
  @output({ handle: "bytes", type: "number" })
  outputBytes?: number;
}
