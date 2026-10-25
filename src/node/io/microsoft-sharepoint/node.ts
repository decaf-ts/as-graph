/**
 * @module as-graph/nodes/io/microsoft-sharepoint
 * @summary Microsoft SharePoint IO node declaration (`core.io.microsoftSharePoint`).
 * @description Microsoft SharePoint — site, list, list-item, and drive-folder
 * operations through the Decaf `MicrosoftSharePointService` (Microsoft Graph).
 * The optional `microsoft-sharepoint` credential (resolved through the
 * ctx-bound node credential resolver) supplies the Graph access token; the
 * node never embeds it. `getSite`/`listLists`/`listDriveItems` require
 * `siteId`; `listItems` requires `siteId` and `listId`; `createListItem` also
 * requires `fields` as an object or JSON string; `listSites` accepts an
 * optional `search` (default `*`). An unknown `operation` silently falls back
 * to `listSites`. A throwaway `MicrosoftSharePointService` is initialized per
 * execution and shut down in a `finally` block.
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
import { MicrosoftSharePointService } from "@decaf-ts/integrations/io/microsoft-sharepoint";
import { bootWithoutEnvironment } from "@decaf-ts/integrations/shared/http";
import {
  asNumber,
  asRecord,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialToken } from "../../credentials";

/** Operations the node can run against Microsoft SharePoint. */
export type SharePointOperation =
  | "listSites"
  | "getSite"
  | "listLists"
  | "listItems"
  | "createListItem"
  | "listDriveItems";

/** Inputs accepted by the Microsoft SharePoint node. */
export type SharePointNodeInput = Record<string, unknown>;

/** Outputs produced by the Microsoft SharePoint node. */
export interface SharePointNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
}

/** Supported operations; unknown configured values fall back to `listSites`. */
const OPERATIONS: SharePointOperation[] = [
  "listSites",
  "getSite",
  "listLists",
  "listItems",
  "createListItem",
  "listDriveItems",
];

/**
 * Parses the configured `fields` value into a SharePoint item fields object.
 *
 * Accepts an object or a JSON object string; empty values yield `undefined`
 * and malformed/non-object values raise `GRAPH_SHAREPOINT_FIELDS_INVALID`.
 *
 * @param value - Raw `fields` input from the node configuration.
 * @returns The parsed fields object, or `undefined` when empty.
 * @throws {GraphExecutionError} with code `GRAPH_SHAREPOINT_FIELDS_INVALID` when the value is not an object or JSON object.
 */
function parseFields(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      const record = asRecord(parsed);
      if (record) return record;
    } catch {
      // fall through to the shared error below
    }
    throw new GraphExecutionError(
      "Microsoft SharePoint fields must be a JSON object",
      "GRAPH_SHAREPOINT_FIELDS_INVALID"
    );
  }
  const record = asRecord(value);
  if (record) return record;
  throw new GraphExecutionError(
    "Microsoft SharePoint fields must be a JSON object",
    "GRAPH_SHAREPOINT_FIELDS_INVALID"
  );
}

/**
 * Microsoft SharePoint node (`core.io.microsoftSharePoint`): site, list, and
 * drive-folder operations through the Decaf `MicrosoftSharePointService`.
 */
@node("core.io.microsoftSharePoint", {
  kind: "core.io.microsoftSharePoint",
  category: "IO",
  color: "#036c70",
  icon: "ti-brand-office",
  width: 96,
  height: 96,
  labels: ["io", "microsoft", "sharepoint", "files", "lists"],
  metadata: {
    title: "graph.node.io.microsoft_sharepoint.name",
    description: "graph.node.io.microsoft_sharepoint.description",
  },
})
@model()
export class MicrosoftSharePointNode extends GraphNode<
  SharePointNodeInput,
  SharePointNodeOutput
> {
  /**
   * Executes the configured Microsoft SharePoint operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `microsoft-sharepoint` Graph access token is resolved via `resolveNodeCredential`.
   * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result`.
   * @throws {GraphExecutionError} with codes `GRAPH_SHAREPOINT_OPERATION_REQUIRED` (no operation configured), `GRAPH_SHAREPOINT_SITE_REQUIRED`/`GRAPH_SHAREPOINT_LIST_REQUIRED`/`GRAPH_SHAREPOINT_ITEM_REQUIRED` (missing per-operation inputs), `GRAPH_SHAREPOINT_FIELDS_INVALID` (malformed fields), or `GRAPH_SHAREPOINT_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<SharePointNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Microsoft SharePoint node requires an operation",
        "GRAPH_SHAREPOINT_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "listSites";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "microsoft-sharepoint",
      false,
      "Microsoft SharePoint"
    );
    const service = new MicrosoftSharePointService();
    try {
      await bootWithoutEnvironment(service, {
        token: credentialToken(secret, "Microsoft SharePoint"),
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "listSites":
          return { result: await service.listSites(this.search ?? "*") };
        case "getSite": {
          if (!this.siteId) {
            throw new GraphExecutionError(
              "Microsoft SharePoint getSite requires a siteId",
              "GRAPH_SHAREPOINT_SITE_REQUIRED"
            );
          }
          return { result: await service.getSite(this.siteId) };
        }
        case "listLists": {
          if (!this.siteId) {
            throw new GraphExecutionError(
              "Microsoft SharePoint listLists requires a siteId",
              "GRAPH_SHAREPOINT_SITE_REQUIRED"
            );
          }
          return { result: await service.listLists(this.siteId) };
        }
        case "listItems": {
          if (!this.siteId || !this.listId) {
            throw new GraphExecutionError(
              "Microsoft SharePoint listItems requires siteId and listId",
              "GRAPH_SHAREPOINT_LIST_REQUIRED"
            );
          }
          return {
            result: await service.listItems({
              siteId: this.siteId,
              listId: this.listId,
              top: asNumber(this.top),
              filter: this.filter,
            }),
          };
        }
        case "createListItem": {
          if (!this.siteId || !this.listId || !this.fields) {
            throw new GraphExecutionError(
              "Microsoft SharePoint createListItem requires siteId, listId, and fields",
              "GRAPH_SHAREPOINT_ITEM_REQUIRED"
            );
          }
          const fields = parseFields(this.fields);
          if (!fields) {
            throw new GraphExecutionError(
              "Microsoft SharePoint createListItem requires fields",
              "GRAPH_SHAREPOINT_ITEM_REQUIRED"
            );
          }
          return {
            result: await service.createListItem({
              siteId: this.siteId,
              listId: this.listId,
              fields,
            }),
          };
        }
        default: {
          if (!this.siteId) {
            throw new GraphExecutionError(
              "Microsoft SharePoint listDriveItems requires a siteId",
              "GRAPH_SHAREPOINT_SITE_REQUIRED"
            );
          }
          return {
            result: await service.listDriveItems({
              siteId: this.siteId,
              itemId: this.itemId,
              top: asNumber(this.top),
            }),
          };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Microsoft SharePoint node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_SHAREPOINT_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** SharePoint operation to perform (default `listSites`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_sharepoint.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: SharePointOperation = "listSites";

  /** SharePoint site ID used by most operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_sharepoint.fields.siteId.label",
    type: "string",
  })
  @input({ handle: "siteId", userControlled: true })
  siteId?: string;

  /** List ID used by list-item operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_sharepoint.fields.listId.label",
    type: "string",
  })
  @input({ handle: "listId", userControlled: true })
  listId?: string;

  /** Drive folder item ID (defaults to the drive root). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_sharepoint.fields.itemId.label",
    type: "string",
  })
  @input({ handle: "itemId", userControlled: true })
  itemId?: string;

  /** Site search term (default `*`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_sharepoint.fields.search.label",
    type: "string",
  })
  @input({ handle: "search", userControlled: true })
  search?: string;

  /** Maximum number of results (`$top`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_sharepoint.fields.top.label",
    type: "number",
  })
  @input({ handle: "top", userControlled: true })
  top?: number;

  /** OData filter expression for `listItems`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_sharepoint.fields.filter.label",
    type: "string",
  })
  @input({ handle: "filter", userControlled: true })
  filter?: string;

  /** New list-item fields as an object or JSON string. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_sharepoint.fields.fields.label",
    type: "textarea",
  })
  @input({ handle: "fields", userControlled: true })
  fields?: unknown;

  /** Optional Microsoft Graph base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.microsoft_sharepoint.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;
}
