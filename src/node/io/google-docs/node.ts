/**
 * @module as-graph/nodes/io/google-docs
 * @summary Google Docs IO node declaration (`core.io.googleDocs`).
 * @description Google Docs — document creation, retrieval, append, replace,
 * and raw batch updates through the Decaf `GoogleDocsService`. The optional
 * `google-docs` credential (resolved through the ctx-bound node credential
 * resolver) supplies an OAuth `token` and/or `apiKey`; the node never embeds
 * credentials. `createDocument` requires `title`; `getDocument`/`batchUpdate`
 * require `documentId` (`batchUpdate` also needs `requests` as a JSON array);
 * `appendText` requires `documentId` and `text`; `replaceAllText` requires
 * `documentId` and `findText`. An unknown `operation` silently falls back to
 * `getDocument`. A throwaway `GoogleDocsService` is initialized per execution
 * and shut down in a `finally` block.
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
import { GoogleDocsService } from "@decaf-ts/integrations/io/google-docs";
import { bootWithoutEnvironment } from "@decaf-ts/integrations/shared/http";
import { asRecord, resolveNodeCredential } from "../../storage/support";
import { credentialValue } from "../../credentials";

/** Operations the node can run against Google Docs. */
export type GoogleDocsOperation =
  | "createDocument"
  | "getDocument"
  | "appendText"
  | "replaceAllText"
  | "batchUpdate";

/** Inputs accepted by the Google Docs node. */
export type GoogleDocsNodeInput = Record<string, unknown>;

/** Outputs produced by the Google Docs node. */
export interface GoogleDocsNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Created or targeted document ID. */
  documentId?: string;
}

/** Supported operations; unknown configured values fall back to `getDocument`. */
const OPERATIONS: GoogleDocsOperation[] = [
  "createDocument",
  "getDocument",
  "appendText",
  "replaceAllText",
  "batchUpdate",
];

/**
 * Parses the configured `requests` value into Docs API request objects.
 *
 * Accepts an array or a JSON array string; anything else raises
 * `GRAPH_GOOGLE_DOCS_REQUESTS_INVALID`.
 *
 * @param value - Raw `requests` input from the node configuration.
 * @returns The request objects.
 * @throws {GraphExecutionError} with code `GRAPH_GOOGLE_DOCS_REQUESTS_INVALID` when the value is not an array or JSON array.
 */
function parseRequests(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to the shared error below
    }
  }
  throw new GraphExecutionError(
    "Google Docs requests must be a JSON array",
    "GRAPH_GOOGLE_DOCS_REQUESTS_INVALID"
  );
}

/**
 * Google Docs node (`core.io.googleDocs`): document content and batch-update
 * operations through the Decaf `GoogleDocsService`.
 */
@node("core.io.googleDocs", {
  kind: "core.io.googleDocs",
  category: "IO",
  color: "#4285f4",
  icon: "ti-brand-google",
  width: 96,
  height: 96,
  labels: ["io", "google", "docs", "document"],
  metadata: {
    title: "graph.node.io.google_docs.name",
    description: "graph.node.io.google_docs.description",
  },
})
@model()
export class GoogleDocsNode extends GraphNode<
  GoogleDocsNodeInput,
  GoogleDocsNodeOutput
> {
  /**
   * Executes the configured Google Docs operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `google-docs` credential supplies the token and/or API key.
   * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result` and the created or targeted `documentId` where available.
   * @throws {GraphExecutionError} with codes `GRAPH_GOOGLE_DOCS_OPERATION_REQUIRED` (no operation configured), `GRAPH_GOOGLE_DOCS_TITLE_REQUIRED`/`GRAPH_GOOGLE_DOCS_DOCUMENT_REQUIRED`/`GRAPH_GOOGLE_DOCS_TEXT_REQUIRED`/`GRAPH_GOOGLE_DOCS_REPLACE_REQUIRED` (missing per-operation inputs), `GRAPH_GOOGLE_DOCS_REQUESTS_INVALID` (malformed requests), or `GRAPH_GOOGLE_DOCS_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<GoogleDocsNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Google Docs node requires an operation",
        "GRAPH_GOOGLE_DOCS_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "getDocument";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "google-docs",
      false,
      "Google Docs"
    );
    const service = new GoogleDocsService();
    try {
      await bootWithoutEnvironment(service, {
        token: credentialValue(secret, "token", "Google Docs"),
        apiKey: credentialValue(secret, "apiKey", "Google Docs"),
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "createDocument": {
          if (!this.title) {
            throw new GraphExecutionError(
              "Google Docs createDocument requires a title",
              "GRAPH_GOOGLE_DOCS_TITLE_REQUIRED"
            );
          }
          const result = await service.createDocument(this.title);
          const record = asRecord(result);
          return {
            result,
            ...(typeof record?.documentId === "string"
              ? { documentId: record.documentId }
              : {}),
          };
        }
        case "getDocument": {
          if (!this.documentId) {
            throw new GraphExecutionError(
              "Google Docs getDocument requires a documentId",
              "GRAPH_GOOGLE_DOCS_DOCUMENT_REQUIRED"
            );
          }
          return {
            result: await service.getDocument(this.documentId),
            documentId: this.documentId,
          };
        }
        case "appendText": {
          if (!this.documentId || !this.text) {
            throw new GraphExecutionError(
              "Google Docs appendText requires documentId and text",
              "GRAPH_GOOGLE_DOCS_TEXT_REQUIRED"
            );
          }
          return {
            result: await service.appendText(this.documentId, this.text),
            documentId: this.documentId,
          };
        }
        case "replaceAllText": {
          if (!this.documentId || !this.findText) {
            throw new GraphExecutionError(
              "Google Docs replaceAllText requires documentId and findText",
              "GRAPH_GOOGLE_DOCS_REPLACE_REQUIRED"
            );
          }
          return {
            result: await service.replaceAllText({
              documentId: this.documentId,
              find: this.findText,
              replace: this.replaceText ?? "",
              matchCase: this.matchCase,
            }),
            documentId: this.documentId,
          };
        }
        default: {
          if (!this.documentId) {
            throw new GraphExecutionError(
              "Google Docs batchUpdate requires a documentId",
              "GRAPH_GOOGLE_DOCS_DOCUMENT_REQUIRED"
            );
          }
          return {
            result: await service.batchUpdate(
              this.documentId,
              parseRequests(this.requests)
            ),
            documentId: this.documentId,
          };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Google Docs node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_GOOGLE_DOCS_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Google Docs operation to perform (default `getDocument`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_docs.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: GoogleDocsOperation = "getDocument";

  /** Document ID used by all operations except `createDocument`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_docs.fields.documentId.label",
    type: "string",
  })
  @input({ handle: "documentId", userControlled: true })
  documentId?: string;

  /** Title of the document created by `createDocument`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_docs.fields.title.label",
    type: "string",
  })
  @input({ handle: "title", userControlled: true })
  title?: string;

  /** Text appended by `appendText`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_docs.fields.text.label",
    type: "textarea",
  })
  @input({ handle: "text", userControlled: true })
  text?: string;

  /** Text searched by `replaceAllText`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_docs.fields.findText.label",
    type: "string",
  })
  @input({ handle: "findText", userControlled: true })
  findText?: string;

  /** Replacement text for `replaceAllText` (default empty). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_docs.fields.replaceText.label",
    type: "string",
  })
  @input({ handle: "replaceText", userControlled: true })
  replaceText?: string;

  /** Whether `replaceAllText` matching is case-sensitive. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_docs.fields.matchCase.label",
    type: "boolean",
  })
  @input({ handle: "matchCase", userControlled: true })
  matchCase?: boolean;

  /** Raw Docs API requests, as an array or JSON string. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_docs.fields.requests.label",
    type: "textarea",
  })
  @input({ handle: "requests", userControlled: true })
  requests?: unknown;

  /** Optional Google Docs API base URL override. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.google_docs.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Created or targeted document ID. */
  @output({ handle: "documentId", type: "string" })
  resultDocumentId?: string;
}
