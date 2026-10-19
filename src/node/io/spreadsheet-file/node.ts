/**
 * @module as-graph/nodes/io/spreadsheet-file
 * @summary Spreadsheet File IO node declaration (Stage 3b; `core.io.spreadsheetFile`).
 * @description Spreadsheet File — parse text content into rows or serialize
 * rows into spreadsheet text (CSV/TSV/JSON) through the Decaf
 * `SpreadsheetService`. `parse` takes `content` (falling back to the `value`
 * input, which must be a string) and honors `format`, `delimiter`, and
 * `hasHeader`; it emits the parsed rows and header. `write` takes `rows` (an
 * array of arrays, falling back to the `value` input) and an optional `header`
 * row, and emits the serialized text. An unknown `operation` silently falls
 * back to `parse`. The shared `SpreadsheetService` is stateless, so it is
 * created once per node instance rather than per execution.
 */
import { model } from "@decaf-ts/decorator-validation";
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
  type SpreadsheetFormat,
} from "@decaf-ts/integrations/io/spreadsheet";
import { asStringArray } from "../../storage/support";

/** Operations the node can run (parse text into rows, or serialize rows into text). */
export type SpreadsheetFileOperation = "parse" | "write";

/** Inputs accepted by the Spreadsheet File node (the optional `value` input feeds `parse` content or `write` rows). */
export type SpreadsheetFileNodeInput = Record<string, unknown>;

/** Outputs produced by the Spreadsheet File node: the operation result plus parsed rows or serialized content. */
export interface SpreadsheetFileNodeOutput {
  result: unknown;
  content?: string;
  rows?: string[][];
  header?: string[];
}

/** All supported operations; unknown configured values fall back to `parse`. */
const OPERATIONS: SpreadsheetFileOperation[] = ["parse", "write"];

/**
 * Spreadsheet File IO node: CSV/TSV/JSON parsing and serialization through `SpreadsheetService`.
 */
@node("core.io.spreadsheetFile", {
  kind: "core.io.spreadsheetFile",
  category: "IO",
  color: "#217346",
  icon: "ti-file-spreadsheet",
  width: 96,
  height: 96,
  labels: ["io", "spreadsheet", "csv", "tsv", "json"],
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
  /** Shared, stateless spreadsheet service reused across executions of this node instance. */
  private readonly spreadsheets = new SpreadsheetService();

  /**
   * Executes the configured spreadsheet operation.
   *
   * @param request - Execution request whose optional `value` input feeds `parse` content or `write` rows.
   * @returns For `parse`: the parsed result on `result` plus `content`, `rows`, and `header`; for `write`: the serialized text on `result` and `content`.
   * @throws {GraphExecutionError} with code `GRAPH_SPREADSHEET_CONTENT_REQUIRED` when `parse` has no string content, `GRAPH_SPREADSHEET_ROWS_REQUIRED` when `write` has no array-of-arrays rows, or `GRAPH_SPREADSHEET_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<SpreadsheetFileNodeInput>
  ): Promise<GraphExecutionValues> {
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "parse";
    try {
      if (operation === "parse") {
        const content = this.content ?? request.inputs["value"];
        if (typeof content !== "string") {
          throw new GraphExecutionError(
            "Spreadsheet File parse requires text content",
            "GRAPH_SPREADSHEET_CONTENT_REQUIRED"
          );
        }
        const result = this.spreadsheets.parse(content, {
          format: this.format,
          delimiter: this.delimiter,
          header: this.hasHeader,
        });
        return {
          result,
          content,
          rows: result.rows,
          header: result.header,
        };
      }
      const rows = Array.isArray(this.rows)
        ? this.rows
        : Array.isArray(request.inputs["value"])
          ? (request.inputs["value"] as unknown[][])
          : undefined;
      if (!rows) {
        throw new GraphExecutionError(
          "Spreadsheet File write requires rows as an array of arrays",
          "GRAPH_SPREADSHEET_ROWS_REQUIRED"
        );
      }
      const content = this.spreadsheets.serialize(rows, {
        format: this.format,
        delimiter: this.delimiter,
        header: asStringArray(this.header)?.map(String),
      });
      return { result: content, content };
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

  /** Operation to run (default `parse`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: SpreadsheetFileOperation = "parse";

  /** Serialization/parsing format (CSV, TSV, or JSON; service default when unset). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.format.label",
    type: "select",
  })
  @input({ handle: "format", userControlled: true })
  format?: SpreadsheetFormat;

  /** Optional field delimiter override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.delimiter.label",
    type: "string",
  })
  @input({ handle: "delimiter", userControlled: true })
  delimiter?: string;

  /** Text content parsed by `parse` (falls back to the `value` input). */
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

  /** Whether `parse` should treat the first row as a header. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.spreadsheet_file.fields.hasHeader.label",
    type: "boolean",
  })
  @input({ handle: "hasHeader", userControlled: true })
  hasHeader?: boolean;

  /** Parsed rows (`parse`) or serialized text (`write`). */
  @output({ handle: "result" })
  result!: unknown;

  /** Input content (`parse`) or serialized text (`write`). */
  @output({ handle: "content", type: "string" })
  outputContent?: string;

  /** Parsed rows emitted by `parse`. */
  @output({ handle: "rows", type: "array" })
  outputRows?: string[][];

  /** Parsed header emitted by `parse`. */
  @output({ handle: "header", type: "array" })
  outputHeader?: string[];
}
