/**
 * @module as-graph/nodes/io/convert-to-file
 * @description Converts item data into file payloads. The implemented
 * operations are `csv`, `html`, `toJson`, `toText`, and `toBinary`; the
 * declared `iCal`, `ods`, `rtf`, `xls`, and `xlsx` operations are accepted by
 * the type but rejected at execution time. Text outputs are UTF-8 encoded with
 * an optional BOM, and every result is a `BinaryFilePayload` carrying base64
 * data, file name, MIME type, and byte length.
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
import {
  asGraphDataArray,
  getGraphDataValue,
  isGraphDataRecord,
} from "../../data/support";
import {
  binaryPayloadOf,
  type BinaryFilePayload,
} from "../file-support";
import { graphDataToHtmlTable } from "../html-support";

/** Target file format; only `csv`, `html`, `toJson`, `toText`, and `toBinary` are implemented. */
export type ConvertToFileOperation =
  | "csv"
  | "html"
  | "iCal"
  | "ods"
  | "rtf"
  | "xls"
  | "xlsx"
  | "toJson"
  | "toText"
  | "toBinary";

/** Inputs accepted by the Convert to File node; `value` carries the items to convert. */
export type ConvertToFileNodeInput = Record<string, unknown>;

/** Outputs produced by the Convert to File node. */
export interface ConvertToFileNodeOutput {
  /** Generated file payload(s). */
  result: BinaryFilePayload | BinaryFilePayload[];

  /** Raw text content for the single-payload text formats (`csv`, `html`, `toJson`). */
  content?: string;

  /** Total payload size in bytes. */
  bytes?: number;
}

const SUPPORTED_OPERATIONS: ConvertToFileOperation[] = [
  "csv",
  "html",
  "toJson",
  "toText",
  "toBinary",
];

function csvCell(value: unknown, delimiter: string): string {
  if (value === undefined || value === null) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  if (
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r") ||
    text.includes(delimiter)
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function recordsToCsv(
  records: Record<string, unknown>[],
  delimiter: string,
  headerRow: boolean
): string {
  const headers = Array.from(
    new Set(records.flatMap((record) => Object.keys(record)))
  );
  const lines: string[] = [];
  if (headerRow) {
    lines.push(headers.map((header) => csvCell(header, delimiter)).join(delimiter));
  }
  for (const record of records) {
    lines.push(
      headers.map((header) => csvCell(record[header], delimiter)).join(delimiter)
    );
  }
  return lines.join("\n");
}

function textBytes(text: string, addBOM?: boolean): Buffer {
  return Buffer.from(`${addBOM ? "\uFEFF" : ""}${text}`, "utf8");
}

/**
 * Convert to File node (`core.io.convertToFile`): serializes items to CSV,
 * HTML, JSON, text, or base64-backed binary file payloads.
 */
@node("core.io.convertToFile", {
  kind: "core.io.convertToFile",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-file-arrow-right",
  width: 96,
  height: 96,
  labels: ["io", "file", "convert", "binary", "csv", "json"],
  metadata: {
    title: "graph.node.io.convert_to_file.name",
    description: "graph.node.io.convert_to_file.description",
  },
})
@model()
export class ConvertToFileNode extends GraphNode<
  ConvertToFileNodeInput,
  ConvertToFileNodeOutput
> {
  /**
   * Converts the input items into file payloads.
   *
   * @param request - Execution request; `inputs.value` holds the items to convert.
   * @returns Execution values with the generated payload(s), the text
   *   `content` for single text files, and the total `bytes`.
   * @throws {GraphExecutionError} `GRAPH_CONVERT_TO_FILE_UNSUPPORTED_OPERATION`
   *   for a declared-but-unimplemented format, or
   *   `GRAPH_CONVERT_TO_FILE_SOURCE_REQUIRED` when `toText`/`toBinary` cannot
   *   find a usable source value.
   */
  override execute(
    request: GraphNodeExecutionRequest<ConvertToFileNodeInput>
  ): GraphExecutionValues {
    if (!SUPPORTED_OPERATIONS.includes(this.operation)) {
      throw new GraphExecutionError(
        `Convert to File operation '${this.operation}' is not supported`,
        "GRAPH_CONVERT_TO_FILE_UNSUPPORTED_OPERATION",
        { operation: this.operation }
      );
    }
    const items = asGraphDataArray(request.inputs["value"]);
    const records = items.map((item) =>
      isGraphDataRecord(item) ? item : { value: item }
    );

    switch (this.operation) {
      case "csv": {
        const text = recordsToCsv(
          records,
          this.delimiter || ",",
          this.headerRow !== false
        );
        const payload = binaryPayloadOf(
          textBytes(text, this.addBOM),
          this.fileName || "file.csv",
          undefined,
          "text/csv"
        );
        return { result: payload, content: text, bytes: payload.byteLength };
      }
      case "html": {
        const table = graphDataToHtmlTable(records, {
          caption: this.caption,
          customStyling: this.customStyling === true,
          capitalize: this.capitalize === true,
        });
        const text = `<!DOCTYPE html><html><body>${table}</body></html>`;
        const payload = binaryPayloadOf(
          textBytes(text, this.addBOM),
          this.fileName || "file.html",
          undefined,
          "text/html"
        );
        return { result: payload, content: text, bytes: payload.byteLength };
      }
      case "toText": {
        const payloads = this.textPayloads(records);
        return this.returnPayloads(payloads);
      }
      case "toBinary": {
        const payloads = this.binaryPayloads(records);
        return this.returnPayloads(payloads);
      }
      case "toJson":
      default: {
        if (this.mode === "each") {
          const payloads = records.map((record) =>
            binaryPayloadOf(
              textBytes(
                JSON.stringify(record, null, this.format ? 2 : 0) as string,
                this.addBOM
              ),
              this.fileName || "file.json",
              undefined,
              "application/json"
            )
          );
          return this.returnPayloads(payloads);
        }
        const text = JSON.stringify(
          records,
          null,
          this.format ? 2 : 0
        ) as string;
        const payload = binaryPayloadOf(
          textBytes(text, this.addBOM),
          this.fileName || "file.json",
          undefined,
          "application/json"
        );
        return { result: payload, content: text, bytes: payload.byteLength };
      }
    }
  }

  private textPayloads(
    records: Record<string, unknown>[]
  ): BinaryFilePayload[] {
    return records.map((record) => {
      const value = this.sourceProperty
        ? getGraphDataValue(record, this.sourceProperty, true)
        : record.value ?? record;
      if (value === undefined || value === null) {
        throw new GraphExecutionError(
          `Convert to File node could not find '${this.sourceProperty}' in the input`,
          "GRAPH_CONVERT_TO_FILE_SOURCE_REQUIRED",
          { sourceProperty: this.sourceProperty }
        );
      }
      const text = typeof value === "string" ? value : String(value);
      return binaryPayloadOf(
        textBytes(text, this.addBOM),
        this.fileName || "file.txt",
        undefined,
        "text/plain"
      );
    });
  }

  private binaryPayloads(
    records: Record<string, unknown>[]
  ): BinaryFilePayload[] {
    return records.map((record) => {
      const value = this.sourceProperty
        ? getGraphDataValue(record, this.sourceProperty, true)
        : record.data ?? record.value;
      if (typeof value !== "string") {
        throw new GraphExecutionError(
          `Convert to File node requires a base64 string in '${this.sourceProperty ?? "data"}'`,
          "GRAPH_CONVERT_TO_FILE_SOURCE_REQUIRED",
          { sourceProperty: this.sourceProperty }
        );
      }
      const base64 = value.startsWith("data:")
        ? value.slice(value.indexOf(",") + 1)
        : value;
      if (this.dataIsBase64 === false) {
        return binaryPayloadOf(
          Buffer.from(base64, "utf8"),
          this.fileName || "file.bin",
          undefined,
          this.mimeType || "application/octet-stream"
        );
      }
      return binaryPayloadOf(
        Buffer.from(base64, "base64"),
        this.fileName || "file.bin",
        undefined,
        this.mimeType || "application/octet-stream"
      );
    });
  }

  private returnPayloads(
    payloads: BinaryFilePayload[]
  ): GraphExecutionValues {
    if (payloads.length === 1) {
      return {
        result: payloads[0],
        bytes: payloads[0].byteLength,
      };
    }
    return {
      result: payloads,
      bytes: payloads.reduce((total, entry) => total + entry.byteLength, 0),
    };
  }

  /** Items to convert; non-records are wrapped as `{ value }`. */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Target format (default `csv`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: ConvertToFileOperation = "csv";

  /** Declared binary property name option; the implemented conversion paths do not read it. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.binaryPropertyName.label",
    type: "text",
  })
  @input({ handle: "binaryPropertyName", userControlled: true })
  binaryPropertyName: string = "data";

  /** Field holding the text or base64 source for `toText`/`toBinary`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.sourceProperty.label",
    placeholder: "graph.node.io.convert_to_file.fields.sourceProperty.placeholder",
    type: "text",
  })
  @input({ handle: "sourceProperty", userControlled: true })
  sourceProperty?: string;

  /** `toJson` output granularity: one payload for all items or one payload per item (default `once`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.mode.label",
    type: "select",
  })
  @input({ handle: "mode", userControlled: true })
  mode: "once" | "each" = "once";

  /** Output file name; each format supplies its own default. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.fileName.label",
    placeholder: "graph.node.io.convert_to_file.fields.fileName.placeholder",
    type: "text",
  })
  @input({ handle: "fileName", userControlled: true })
  fileName?: string;

  /** MIME type override for binary outputs. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.mimeType.label",
    type: "text",
  })
  @input({ handle: "mimeType", userControlled: true })
  mimeType?: string;

  /** CSV field delimiter (default `,`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.delimiter.label",
    type: "text",
  })
  @input({ handle: "delimiter", userControlled: true })
  delimiter?: string = ",";

  /** Emit a CSV header row (default `true`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.headerRow.label",
    type: "checkbox",
  })
  @input({ handle: "headerRow", userControlled: true })
  headerRow?: boolean = true;

  /** Declared spreadsheet sheet name option; the implemented paths do not read it. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.sheetName.label",
    type: "text",
  })
  @input({ handle: "sheetName", userControlled: true })
  sheetName?: string;

  /** Prefix UTF-8 text output with a byte-order mark (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.addBOM.label",
    type: "checkbox",
  })
  @input({ handle: "addBOM", userControlled: true })
  addBOM?: boolean = false;

  /** Pretty-print JSON with two-space indentation (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.format.label",
    type: "checkbox",
  })
  @input({ handle: "format", userControlled: true })
  format?: boolean = false;

  /** Treat the `toBinary` source as base64; when `false` it is read as UTF-8 (default `true`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.dataIsBase64.label",
    type: "checkbox",
  })
  @input({ handle: "dataIsBase64", userControlled: true })
  dataIsBase64?: boolean = true;

  /** Caption for the generated HTML table. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.caption.label",
    type: "text",
  })
  @input({ handle: "caption", userControlled: true })
  caption?: string;

  /** Omit the default inline table styles (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.customStyling.label",
    type: "checkbox",
  })
  @input({ handle: "customStyling", userControlled: true })
  customStyling?: boolean = false;

  /** Capitalize and humanize HTML table headers (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.convert_to_file.fields.capitalize.label",
    type: "checkbox",
  })
  @input({ handle: "capitalize", userControlled: true })
  capitalize?: boolean = false;

  /** Generated payload(s). */
  @required()
  @output({ handle: "result" })
  result!: BinaryFilePayload | BinaryFilePayload[];

  /** Raw text content for single-payload text formats. */
  @output({ handle: "content" })
  content?: string;

  /** Total payload size in bytes. */
  @output({ handle: "bytes" })
  bytes?: number;
}
