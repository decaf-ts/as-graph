/**
 * @module as-graph/nodes/io/google-sheets
 * @summary Google Sheets IO node declaration (Stage 3b; `core.io.googleSheets`).
 * @description Google Sheets — read/write/clear a range, append rows, or
 * create a spreadsheet through the Decaf `GoogleSheetsService` REST API. The
 * `google-sheets` credential (resolved through a `GRAPH_CREDENTIAL_*`
 * environment variable) supplies an OAuth `token` or an `apiKey` (read-only).
 * `spreadsheetId` and `range` are required by everything except `create`,
 * which needs a `title` instead; `update`/`append` also require `values` as an
 * array of rows and honour `valueInputOption` (default `USER_ENTERED`). An
 * unknown `operation` silently falls back to `get`. A throwaway
 * `GoogleSheetsService` is initialized per execution and shut down in a
 * `finally` block.
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
import { GoogleSheetsService } from "@decaf-ts/integrations/io/google-sheets";
import { resolveCredentialSecret } from "../../storage/support";
import { credentialValue } from "../../credentials";

/** Operations the node can run against Google Sheets. */
export type GoogleSheetsOperation =
  | "get"
  | "update"
  | "append"
  | "clear"
  | "create";

/** How input values are interpreted by the Sheets API (`RAW` stores text, `USER_ENTERED` parses formulas). */
export type GoogleSheetsValueInputOption = "RAW" | "USER_ENTERED";

/** Inputs accepted by the Google Sheets node. */
export type GoogleSheetsNodeInput = Record<string, unknown>;

/** Outputs produced by the Google Sheets node. */
export interface GoogleSheetsNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Cell values returned by `get`, `update`, and `append`. */
  values?: string[][];
  /** Target or created spreadsheet ID. */
  spreadsheetId?: string;
  /** Affected range (the cleared range for `clear`). */
  range?: string;
}

/** All supported operations; unknown configured values fall back to `get`. */
const OPERATIONS: GoogleSheetsOperation[] = [
  "get",
  "update",
  "append",
  "clear",
  "create",
];

/**
 * Google Sheets IO node: spreadsheet read/write operations through `GoogleSheetsService`.
 */
@node("core.io.googleSheets", {
  kind: "core.io.googleSheets",
  category: "IO",
  color: "#0f9d58",
  icon: "ti-brand-google",
  width: 96,
  height: 96,
  labels: ["io", "google", "sheets", "spreadsheet"],
  metadata: {
    title: "graph.node.io.google_sheets.name",
    description: "graph.node.io.google_sheets.description",
  },
})
@model()
export class GoogleSheetsNode extends GraphNode<
  GoogleSheetsNodeInput,
  GoogleSheetsNodeOutput
> {
  /**
   * Executes the configured Google Sheets operation.
   *
   * @param request - Execution request carrying the credential secrets; the `google-sheets` credential supplies `token`/`apiKey`.
   * @returns Execution values with the service response on `result` and the `values`, `spreadsheetId`, and `range` outputs where the operation reports them.
   * @throws {GraphExecutionError} with codes `GRAPH_GOOGLE_SHEETS_OPERATION_REQUIRED` (no operation configured), `GRAPH_GOOGLE_SHEETS_SPREADSHEET_REQUIRED`, `GRAPH_GOOGLE_SHEETS_RANGE_REQUIRED`, `GRAPH_GOOGLE_SHEETS_VALUES_REQUIRED`, `GRAPH_GOOGLE_SHEETS_TITLE_REQUIRED` (missing per-operation inputs), `GRAPH_CREDENTIAL_*` codes from credential resolution, or `GRAPH_GOOGLE_SHEETS_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<GoogleSheetsNodeInput>
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Google Sheets node requires an operation",
        "GRAPH_GOOGLE_SHEETS_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "get";
    const secret = resolveCredentialSecret(
      request.credentials,
      "google-sheets",
      false,
      "Google Sheets"
    );
    const service = new GoogleSheetsService();
    try {
      await service.initialize({
        token: credentialValue(secret, "token", "Google Sheets"),
        apiKey: credentialValue(secret, "apiKey", "Google Sheets"),
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "get": {
          const result = await service.getValues(
            this.requireSpreadsheet(),
            this.requireRange()
          );
          return {
            result,
            values: result.values,
            spreadsheetId: result.spreadsheetId,
            range: result.range,
          };
        }
        case "update":
        case "append": {
          const values = this.requireValues();
          const payload = {
            spreadsheetId: this.requireSpreadsheet(),
            range: this.requireRange(),
            values,
            valueInputOption: this.valueInputOption ?? "USER_ENTERED",
          };
          const result =
            operation === "update"
              ? await service.updateValues(payload)
              : await service.appendValues(payload);
          return {
            result,
            values: result.values,
            spreadsheetId: result.spreadsheetId,
            range: result.range,
          };
        }
        case "clear": {
          const result = await service.clearValues(
            this.requireSpreadsheet(),
            this.requireRange()
          );
          return {
            result,
            spreadsheetId: result.spreadsheetId,
            range: result.clearedRange,
          };
        }
        default: {
          if (!this.title) {
            throw new GraphExecutionError(
              "Google Sheets create requires a title",
              "GRAPH_GOOGLE_SHEETS_TITLE_REQUIRED"
            );
          }
          const result = await service.createSpreadsheet(this.title);
          return {
            result,
            spreadsheetId: result.spreadsheetId,
          };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Google Sheets node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_GOOGLE_SHEETS_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /**
   * Validates and returns the configured spreadsheet ID.
   *
   * @returns The configured spreadsheet ID.
   * @throws {GraphExecutionError} with code `GRAPH_GOOGLE_SHEETS_SPREADSHEET_REQUIRED` when no `spreadsheetId` is configured.
   */
  private requireSpreadsheet(): string {
    if (!this.spreadsheetId) {
      throw new GraphExecutionError(
        "Google Sheets node requires a spreadsheet ID",
        "GRAPH_GOOGLE_SHEETS_SPREADSHEET_REQUIRED"
      );
    }
    return this.spreadsheetId;
  }

  /**
   * Validates and returns the configured A1 range.
   *
   * @returns The configured range.
   * @throws {GraphExecutionError} with code `GRAPH_GOOGLE_SHEETS_RANGE_REQUIRED` when no `range` is configured.
   */
  private requireRange(): string {
    if (!this.range) {
      throw new GraphExecutionError(
        "Google Sheets node requires a range",
        "GRAPH_GOOGLE_SHEETS_RANGE_REQUIRED"
      );
    }
    return this.range;
  }

  /**
   * Validates and returns the configured cell values.
   *
   * @returns The configured values (an array of row arrays).
   * @throws {GraphExecutionError} with code `GRAPH_GOOGLE_SHEETS_VALUES_REQUIRED` when `values` is not an array of arrays.
   */
  private requireValues(): unknown[][] {
    if (
      !Array.isArray(this.values) ||
      !this.values.every((row) => Array.isArray(row))
    ) {
      throw new GraphExecutionError(
        "Google Sheets node requires values as an array of rows",
        "GRAPH_GOOGLE_SHEETS_VALUES_REQUIRED"
      );
    }
    return this.values;
  }

  /** Operation to run (default `get`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_sheets.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: GoogleSheetsOperation = "get";

  /** Target spreadsheet ID (required by `get`, `update`, `append`, and `clear`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_sheets.fields.spreadsheetId.label",
    type: "string",
  })
  @input({ handle: "spreadsheetId", userControlled: true })
  spreadsheetId?: string;

  /** A1 notation range (required by `get`, `update`, `append`, and `clear`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_sheets.fields.range.label",
    type: "string",
  })
  @input({ handle: "range", userControlled: true })
  range?: string;

  /** Rows to write (required by `update`/`append`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_sheets.fields.values.label",
    type: "json",
  })
  @input({ handle: "values", userControlled: true })
  values?: unknown[][];

  /** Value interpretation for `update`/`append` (default `USER_ENTERED`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_sheets.fields.valueInputOption.label",
    type: "select",
  })
  @input({ handle: "valueInputOption", userControlled: true })
  valueInputOption?: GoogleSheetsValueInputOption;

  /** New spreadsheet title (required by `create`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_sheets.fields.title.label",
    type: "string",
  })
  @input({ handle: "title", userControlled: true })
  title?: string;

  /** Optional API base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_sheets.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Cell values returned by `get`, `update`, and `append`. */
  @output({ handle: "values", type: "array" })
  outputValues?: string[][];

  /** Spreadsheet ID echoed by the service (also returned by `create`). */
  @output({ handle: "spreadsheetId", type: "string" })
  outputSpreadsheetId?: string;

  /** Affected range (the cleared range for `clear`). */
  @output({ handle: "range", type: "string" })
  outputRange?: string;
}
