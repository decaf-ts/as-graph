/**
 * @module as-graph/nodes/io/airtable
 * @summary Airtable IO node declaration (Stage 3b; `core.io.airtable`).
 * @description Airtable — record CRUD against a base through the Decaf
 * `AirtableNodeService`. The `airtable` credential (resolved through the
 * ctx-bound node credential resolver) supplies the API token and may
 * also carry a default `baseId`; the node's `baseId` wins. `table` is required
 * by every operation; `get`/`update`/`delete` additionally require a
 * `recordId`, and `create`/`update` require `recordFields` as an object.
 * `list` supports a view, `filterByFormula`, field selection, sorting,
 * pagination caps, and returns the next-page `offset`. An unknown `operation`
 * silently falls back to `list`. A throwaway `AirtableNodeService` is initialized
 * per execution and shut down in a `finally` block.
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
import { AirtableNodeService } from "@decaf-ts/integrations/io/airtable";
import {
  asNumber,
  asRecord,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialValue } from "../../credentials";

/** Operation the node performs against the Airtable API. */
export type AirtableOperation =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete";

/** Inputs accepted by the Airtable node. */
export type AirtableNodeInput = Record<string, unknown>;

/** Outputs produced by the Airtable node. */
export interface AirtableNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Affected/fetched record(s) (`list` returns the page's records, writes wrap the single record). */
  records?: unknown[];
  /** Next-page offset for continued `list` calls. */
  offset?: string;
}

/** Supported operations; unknown configured values fall back to `list`. */
const OPERATIONS: AirtableOperation[] = [
  "list",
  "get",
  "create",
  "update",
  "delete",
];

/**
 * Airtable node (`core.io.airtable`): record CRUD through the Decaf
 * `AirtableNodeService`.
 */
@node("core.io.airtable", {
  kind: "core.io.airtable",
  category: "IO",
  color: "#fcb400",
  icon: "ti-table",
  width: 96,
  height: 96,
  labels: ["io", "airtable", "database", "records"],
  metadata: {
    title: "graph.node.io.airtable.name",
    description: "graph.node.io.airtable.description",
  },
})
@model()
export class AirtableNode extends GraphNode<
  AirtableNodeInput,
  AirtableNodeOutput
> {
  /**
   * Executes the configured Airtable operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `airtable` credential supplies the token and default `baseId`.
    * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result`, the affected records on `records`, and the `offset` continuation token for `list`.
   * @throws {GraphExecutionError} with codes `GRAPH_AIRTABLE_OPERATION_REQUIRED` (no operation configured), `GRAPH_AIRTABLE_TABLE_REQUIRED`/`GRAPH_AIRTABLE_RECORD_REQUIRED`/`GRAPH_AIRTABLE_FIELDS_REQUIRED` (missing per-operation inputs), or `GRAPH_AIRTABLE_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<AirtableNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Airtable node requires an operation",
        "GRAPH_AIRTABLE_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "list";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "airtable",
      false,
      "Airtable"
    );
    const service = new AirtableNodeService();
    try {
      await service.boot({
        token: credentialValue(secret, "token", "Airtable"),
        baseId: this.baseId ?? credentialValue(secret, "baseId", "Airtable"),
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "list": {
          const result = await service.listRecords({
            table: this.requireTable(),
            view: this.view,
            filterByFormula: this.filterByFormula,
            maxRecords: asNumber(this.maxRecords),
            pageSize: asNumber(this.pageSize),
            offset: this.offset,
            fields: Array.isArray(this.fields)
              ? this.fields.map(String)
              : undefined,
            sort: this.sortField
              ? [
                  {
                    field: this.sortField,
                    direction: this.sortDirection,
                  },
                ]
              : undefined,
          });
          return {
            result,
            records: result.records,
            offset: result.offset,
          };
        }
        case "get": {
          const result = await service.getRecord(
            this.requireTable(),
            this.requireRecordId()
          );
          return { result, records: [result] };
        }
        case "create": {
          const result = await service.createRecord({
            table: this.requireTable(),
            fields: this.requireRecordFields(),
            typecast: this.typecast,
          });
          return { result, records: [result] };
        }
        case "update": {
          const result = await service.updateRecord({
            table: this.requireTable(),
            recordId: this.requireRecordId(),
            fields: this.requireRecordFields(),
            typecast: this.typecast,
          });
          return { result, records: [result] };
        }
        default:
          return {
            result: await service.deleteRecord(
              this.requireTable(),
              this.requireRecordId()
            ),
          };
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Airtable node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_AIRTABLE_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Returns the configured table name or throws `GRAPH_AIRTABLE_TABLE_REQUIRED`. */
  private requireTable(): string {
    if (!this.table) {
      throw new GraphExecutionError(
        "Airtable node requires a table",
        "GRAPH_AIRTABLE_TABLE_REQUIRED"
      );
    }
    return this.table;
  }

  /** Returns the configured record id or throws `GRAPH_AIRTABLE_RECORD_REQUIRED`. */
  private requireRecordId(): string {
    if (!this.recordId) {
      throw new GraphExecutionError(
        "Airtable node requires a record ID",
        "GRAPH_AIRTABLE_RECORD_REQUIRED"
      );
    }
    return this.recordId;
  }

  /** Returns the configured record fields object or throws `GRAPH_AIRTABLE_FIELDS_REQUIRED`. */
  private requireRecordFields(): Record<string, unknown> {
    const fields = asRecord(this.recordFields);
    if (!fields) {
      throw new GraphExecutionError(
        "Airtable node requires recordFields as an object",
        "GRAPH_AIRTABLE_FIELDS_REQUIRED"
      );
    }
    return fields;
  }

  /** Airtable operation to perform (default `list`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: AirtableOperation = "list";

  /** Base id (falls back to the credential `baseId` field). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.baseId.label",
    type: "string",
  })
  @input({ handle: "baseId", userControlled: true })
  baseId?: string;

  /** Table name or id (required by every operation). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.table.label",
    type: "string",
  })
  @input({ handle: "table", userControlled: true })
  table?: string;

  /** Record id (required by `get`/`update`/`delete`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.recordId.label",
    type: "string",
  })
  @input({ handle: "recordId", userControlled: true })
  recordId?: string;

  /** Field values object (required by `create`/`update`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.recordFields.label",
    type: "json",
  })
  @input({ handle: "recordFields", userControlled: true })
  recordFields?: Record<string, unknown>;

  /** Let Airtable cast values to column types on writes. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.typecast.label",
    type: "boolean",
  })
  @input({ handle: "typecast", userControlled: true })
  typecast?: boolean;

  /** View id or name restricting `list`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.view.label",
    type: "string",
  })
  @input({ handle: "view", userControlled: true })
  view?: string;

  /** Airtable formula filtering `list` results. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.filterByFormula.label",
    type: "string",
  })
  @input({ handle: "filterByFormula", userControlled: true })
  filterByFormula?: string;

  /** Field names returned by `list`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.fields.label",
    type: "json",
  })
  @input({ handle: "fields", userControlled: true })
  fields?: string[];

  /** Single sort field for `list`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.sortField.label",
    type: "string",
  })
  @input({ handle: "sortField", userControlled: true })
  sortField?: string;

  /** Sort direction for `sortField`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.sortDirection.label",
    type: "select",
  })
  @input({ handle: "sortDirection", userControlled: true })
  sortDirection?: "asc" | "desc";

  /** Total record cap for `list`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.maxRecords.label",
    type: "number",
  })
  @input({ handle: "maxRecords", userControlled: true })
  maxRecords?: number;

  /** Records per page for `list`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.pageSize.label",
    type: "number",
  })
  @input({ handle: "pageSize", userControlled: true })
  pageSize?: number;

  /** Continuation token from a previous `list` page. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.offset.label",
    type: "string",
  })
  @input({ handle: "offset", userControlled: true })
  offset?: string;

  /** Optional API base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.airtable.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Affected/fetched records (empty for `delete`). */
  @output({ handle: "records", type: "array" })
  records?: unknown[];

  /** Next-page continuation token (`list` only). */
  @output({ handle: "offset", type: "string" })
  nextOffset?: string;
}
