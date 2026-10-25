/**
 * @module as-graph/nodes/io/confluence
 * @summary Confluence IO node declaration (`core.io.confluence`).
 * @description Confluence — spaces, pages, and CQL search through the Decaf
 * `ConfluenceService`. The optional `confluence` credential (resolved through
 * the ctx-bound node credential resolver) supplies the API token, optional
 * Basic-auth `username`, and site `baseUrl`; the node's `baseUrl` wins when
 * set. The node never embeds credentials. `getPage`/`deletePage` require
 * `pageId`; `createPage` requires `spaceKey` and `title`; `updatePage` requires
 * `pageId` and `title` (version is auto-incremented when omitted); `search`
 * requires `cql`; `listSpaces` accepts an optional `limit`. An unknown
 * `operation` silently falls back to `getPage`. A throwaway
 * `ConfluenceService` is initialized per execution and shut down in a
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
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { ConfluenceService } from "@decaf-ts/integrations/io/confluence";
import { bootWithoutEnvironment } from "@decaf-ts/integrations/shared/http";
import { asNumber, resolveNodeCredential } from "../../storage/support";
import { credentialValue } from "../../credentials";

/** Operations the node can run against Confluence. */
export type ConfluenceOperation =
  | "getPage"
  | "listSpaces"
  | "createPage"
  | "updatePage"
  | "deletePage"
  | "search";

/** Inputs accepted by the Confluence node. */
export type ConfluenceNodeInput = Record<string, unknown>;

/** Outputs produced by the Confluence node. */
export interface ConfluenceNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
}

/** Supported operations; unknown configured values fall back to `getPage`. */
const OPERATIONS: ConfluenceOperation[] = [
  "getPage",
  "listSpaces",
  "createPage",
  "updatePage",
  "deletePage",
  "search",
];

/**
 * Confluence node (`core.io.confluence`): space, page, and CQL operations
 * through the Decaf `ConfluenceService`.
 */
@node("core.io.confluence", {
  kind: "core.io.confluence",
  category: "IO",
  color: "#0052cc",
  icon: "ti-file-text",
  width: 96,
  height: 96,
  labels: ["io", "confluence", "wiki", "atlassian", "documentation"],
  metadata: {
    title: "graph.node.io.confluence.name",
    description: "graph.node.io.confluence.description",
  },
})
@model()
export class ConfluenceNode extends GraphNode<
  ConfluenceNodeInput,
  ConfluenceNodeOutput
> {
  /**
   * Executes the configured Confluence operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `confluence` credential supplies the token, username, and base URL.
   * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result`.
   * @throws {GraphExecutionError} with codes `GRAPH_CONFLUENCE_OPERATION_REQUIRED` (no operation configured), `GRAPH_CONFLUENCE_PAGE_REQUIRED`/`GRAPH_CONFLUENCE_CREATE_REQUIRED`/`GRAPH_CONFLUENCE_UPDATE_REQUIRED`/`GRAPH_CONFLUENCE_SEARCH_REQUIRED` (missing per-operation inputs), or `GRAPH_CONFLUENCE_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<ConfluenceNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Confluence node requires an operation",
        "GRAPH_CONFLUENCE_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "getPage";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "confluence",
      false,
      "Confluence"
    );
    const service = new ConfluenceService();
    try {
      await bootWithoutEnvironment(service, {
        token: credentialValue(secret, "token", "Confluence"),
        username: credentialValue(secret, "username", "Confluence"),
        baseUrl:
          this.baseUrl ??
          credentialValue(secret, "baseUrl", "Confluence"),
      });
      switch (operation) {
        case "getPage": {
          if (!this.pageId) {
            throw new GraphExecutionError(
              "Confluence getPage requires a pageId",
              "GRAPH_CONFLUENCE_PAGE_REQUIRED"
            );
          }
          return { result: await service.getPage(this.pageId) };
        }
        case "listSpaces":
          return {
            result: await service.listSpaces(asNumber(this.limit) ?? 25),
          };
        case "createPage": {
          if (!this.spaceKey || !this.title) {
            throw new GraphExecutionError(
              "Confluence createPage requires spaceKey and title",
              "GRAPH_CONFLUENCE_CREATE_REQUIRED"
            );
          }
          return {
            result: await service.createPage({
              spaceKey: this.spaceKey,
              title: this.title,
              body: this.body ?? "",
              parentId: this.parentId,
            }),
          };
        }
        case "updatePage": {
          if (!this.pageId || !this.title) {
            throw new GraphExecutionError(
              "Confluence updatePage requires pageId and title",
              "GRAPH_CONFLUENCE_UPDATE_REQUIRED"
            );
          }
          return {
            result: await service.updatePage({
              pageId: this.pageId,
              title: this.title,
              body: this.body ?? "",
              version: asNumber(this.version),
            }),
          };
        }
        case "deletePage": {
          if (!this.pageId) {
            throw new GraphExecutionError(
              "Confluence deletePage requires a pageId",
              "GRAPH_CONFLUENCE_PAGE_REQUIRED"
            );
          }
          return { result: await service.deletePage(this.pageId) };
        }
        default: {
          if (!this.cql) {
            throw new GraphExecutionError(
              "Confluence search requires a cql query",
              "GRAPH_CONFLUENCE_SEARCH_REQUIRED"
            );
          }
          return {
            result: await service.search({
              cql: this.cql,
              limit: asNumber(this.limit),
            }),
          };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Confluence node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_CONFLUENCE_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Confluence operation to perform (default `getPage`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.confluence.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: ConfluenceOperation = "getPage";

  /** Page ID used by get/update/delete operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.confluence.fields.pageId.label",
    type: "string",
  })
  @input({ handle: "pageId", userControlled: true })
  pageId?: string;

  /** Space key used by `createPage`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.confluence.fields.spaceKey.label",
    type: "string",
  })
  @input({ handle: "spaceKey", userControlled: true })
  spaceKey?: string;

  /** Page title used by create/update operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.confluence.fields.title.label",
    type: "string",
  })
  @input({ handle: "title", userControlled: true })
  title?: string;

  /** Page body in Confluence storage format. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.confluence.fields.body.label",
    type: "textarea",
  })
  @input({ handle: "body", userControlled: true })
  body?: string;

  /** Optional parent page ID for `createPage`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.confluence.fields.parentId.label",
    type: "string",
  })
  @input({ handle: "parentId", userControlled: true })
  parentId?: string;

  /** Explicit new version for `updatePage` (auto-incremented when omitted). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.confluence.fields.version.label",
    type: "number",
  })
  @input({ handle: "version", userControlled: true })
  version?: number;

  /** CQL query used by `search`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.confluence.fields.cql.label",
    type: "string",
  })
  @input({ handle: "cql", userControlled: true })
  cql?: string;

  /** Result limit for `listSpaces` and `search`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.confluence.fields.limit.label",
    type: "number",
  })
  @input({ handle: "limit", userControlled: true })
  limit?: number;

  /** Optional Confluence site base URL (overrides the credential value). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.confluence.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;
}
