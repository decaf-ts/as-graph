/**
 * @module as-graph/nodes/io/microsoft-excel
 * @summary Microsoft Excel IO node declaration (`core.io.microsoftExcel`).
 * @description Microsoft Excel — worksheet, range, and table operations
 * through the Decaf `MicrosoftExcelService` (Microsoft Graph). The optional
 * `microsoft-excel` credential (resolved through the ctx-bound node credential
 * resolver) supplies the Graph access token; the node never embeds it. Every
 * operation requires the workbook `itemId`; `getRange`/`updateRange` also
 * require `worksheet` and `range`, and `updateRange`/`addTableRow` require
 * `values` as a JSON array (JSON string accepted). `addTableRow` also requires
 * `tableId`. Values are coerced into a row matrix; an unknown `operation`
 * silently falls back to `getRange`. A throwaway `MicrosoftExcelService` is
 * initialized per execution and shut down in a `finally` block.
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
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { MicrosoftExcelService } from "@decaf-ts/integrations/io/microsoft-excel";
import { bootWithoutEnvironment } from "@decaf-ts/integrations/shared/http";
import { resolveNodeCredential } from "../../storage/support";
import { credentialToken } from "../../credentials";

/** Operations the node can run against Microsoft Excel. */
export type MicrosoftExcelOperation =
  | "listWorksheets"
  | "getRange"
  | "updateRange"
  | "listTables"
  | "addTableRow";

/** Inputs accepted by the Microsoft Excel node. */
export type MicrosoftExcelNodeInput = Record<string, unknown>;

/** Outputs produced by the Microsoft Excel node. */
export interface MicrosoftExcelNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
}

/** Supported operations; unknown configured values fall back to `getRange`. */
const OPERATIONS: MicrosoftExcelOperation[] = [
  "listWorksheets",
  "getRange",
  "updateRange",
  "listTables",
  "addTableRow",
];

/**
 * Parses the configured `values` value into an array.
 *
 * Accepts an array or a JSON array string; empty or non-array values raise
 * `GRAPH_EXCEL_VALUES_REQUIRED` or `GRAPH_EXCEL_VALUES_INVALID`.
 *
 * @param value - Raw `values` input from the node configuration.
 * @returns The parsed value array.
 * @throws {GraphExecutionError} with code `GRAPH_EXCEL_VALUES_REQUIRED` when empty, or `GRAPH_EXCEL_VALUES_INVALID` when not an array/JSON array.
 */
function parseValues(value: unknown): unknown[] {
  if (value === undefined || value === null || value === "") {
    throw new GraphExecutionError(
      "Microsoft Excel operation requires values",
      "GRAPH_EXCEL_VALUES_REQUIRED"
    );
  }
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      throw new GraphExecutionError(
        "Microsoft Excel values must be a JSON array",
        "GRAPH_EXCEL_VALUES_INVALID"
      );
    }
  }
  throw new GraphExecutionError(
    "Microsoft Excel values must be a JSON array",
    "GRAPH_EXCEL_VALUES_INVALID"
  );
}

/**
 * Normalizes the configured `values` value into a row matrix.
 *
 * A flat array becomes a single row; an array of arrays is returned as-is.
 *
 * @param value - Raw `values` input from the node configuration.
 * @returns The row matrix.
 * @throws {GraphExecutionError} with code `GRAPH_EXCEL_VALUES_REQUIRED` when empty, or `GRAPH_EXCEL_VALUES_INVALID` when not an array/JSON array.
 */
function parseRows(value: unknown): unknown[][] {
  const parsed = parseValues(value);
  if (parsed.length === 0) return [];
  return Array.isArray(parsed[0])
    ? (parsed as unknown[][])
    : [parsed as unknown[]];
}

/**
 * Microsoft Excel node (`core.io.microsoftExcel`): workbook worksheet, range,
 * and table operations through the Decaf `MicrosoftExcelService`.
 */
@node("core.io.microsoftExcel", {
  kind: "core.io.microsoftExcel",
  category: "IO",
  color: "#217346",
  icon: "ti-file-spreadsheet",
  width: 96,
  height: 96,
  labels: ["io", "microsoft", "excel", "spreadsheet", "onedrive"],
  metadata: {
    title: "graph.node.io.microsoft_excel.name",
    description: "graph.node.io.microsoft_excel.description",
  },
})
@model()
export class MicrosoftExcelNode extends GraphNode<
  MicrosoftExcelNodeInput,
  MicrosoftExcelNodeOutput
> {
  /**
   * Executes the configured Microsoft Excel operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `microsoft-excel` Graph access token is resolved via `resolveNodeCredential`.
   * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result`.
   * @throws {GraphExecutionError} with codes `GRAPH_EXCEL_OPERATION_REQUIRED` (no operation configured), `GRAPH_EXCEL_VALUES_REQUIRED`/`GRAPH_EXCEL_VALUES_INVALID` (missing or malformed values), or `GRAPH_EXCEL_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<MicrosoftExcelNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Microsoft Excel node requires an operation",
        "GRAPH_EXCEL_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "getRange";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "microsoft-excel",
      false,
      "Microsoft Excel"
    );
    const service = new MicrosoftExcelService();
    try {
      await bootWithoutEnvironment(service, {
        token: credentialToken(secret, "Microsoft Excel"),
        baseUrl: this.baseUrl,
      });
      const workbook = { itemId: this.itemId ?? "", driveId: this.driveId };
      switch (operation) {
        case "listWorksheets":
          return {
            result: await service.listWorksheets(workbook),
          };
        case "getRange":
          return {
            result: await service.getRange({
              ...workbook,
              worksheet: this.worksheet ?? "",
              range: this.range ?? "",
            }),
          };
        case "updateRange":
          return {
            result: await service.updateRange({
              ...workbook,
              worksheet: this.worksheet ?? "",
              range: this.range ?? "",
              values: parseRows(this.values),
            }),
          };
        case "listTables":
          return {
            result: await service.listTables(workbook),
          };
        default: {
          const rows = parseRows(this.values);
          return {
            result: await service.addTableRow({
              ...workbook,
              tableId: this.tableId ?? "",
              values: rows[0] ?? [],
            }),
          };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Microsoft Excel node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_EXCEL_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Excel operation to perform (default `getRange`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_excel.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: MicrosoftExcelOperation = "getRange";

  /** Drive item ID of the workbook. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_excel.fields.itemId.label",
    type: "string",
  })
  @input({ handle: "itemId", userControlled: true })
  itemId?: string;

  /** Drive ID owning the workbook (defaults to the user's drive). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_excel.fields.driveId.label",
    type: "string",
  })
  @input({ handle: "driveId", userControlled: true })
  driveId?: string;

  /** Worksheet name for range operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_excel.fields.worksheet.label",
    type: "string",
  })
  @input({ handle: "worksheet", userControlled: true })
  worksheet?: string;

  /** A1-style range address (e.g. `A1:C10`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_excel.fields.range.label",
    type: "string",
  })
  @input({ handle: "range", userControlled: true })
  range?: string;

  /** Cell values or row matrix, as an array or JSON string. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_excel.fields.values.label",
    type: "textarea",
  })
  @input({ handle: "values", userControlled: true })
  values?: unknown;

  /** Table ID used by `addTableRow`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_excel.fields.tableId.label",
    type: "string",
  })
  @input({ handle: "tableId", userControlled: true })
  tableId?: string;

  /** Optional Microsoft Graph base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_excel.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;
}
