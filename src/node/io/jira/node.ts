/**
 * @module as-graph/nodes/io/jira
 * @summary Jira IO node declaration (`core.io.jira`).
 * @description Jira — issue CRUD, comments, workflow transitions, and JQL
 * search through the Decaf `JiraService`. The optional `jira` credential
 * (resolved through the ctx-bound node credential resolver) supplies the API
 * token, optional Basic-auth `username`, and site `baseUrl`; the node's
 * `baseUrl` wins when set. The node never embeds credentials. `createIssue`
 * requires `projectKey` and `summary` and accepts `fields` as an object or JSON
 * string; `getIssue`/`updateIssue`/`deleteIssue`/`getTransitions`/
 * `transitionIssue`/`addComment` require `issueKey` (plus `fields`,
 * `transitionId`, or `comment` where applicable); `search` requires `jql`. An
 * unknown `operation` silently falls back to `createIssue`. A throwaway
 * `JiraService` is initialized per execution and shut down in a `finally`
 * block.
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
import { JiraService } from "@decaf-ts/integrations/io/jira";
import { bootWithoutEnvironment } from "@decaf-ts/integrations/shared/http";
import {
  asNumber,
  asRecord,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialValue } from "../../credentials";

/** Operations the node can run against Jira. */
export type JiraOperation =
  | "createIssue"
  | "getIssue"
  | "updateIssue"
  | "deleteIssue"
  | "addComment"
  | "getTransitions"
  | "transitionIssue"
  | "search";

/** Inputs accepted by the Jira node. */
export type JiraNodeInput = Record<string, unknown>;

/** Outputs produced by the Jira node. */
export interface JiraNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Created, fetched, updated, transitioned, or commented-on issue key. */
  issueKey?: string;
}

/** Supported operations; unknown configured values fall back to `createIssue`. */
const OPERATIONS: JiraOperation[] = [
  "createIssue",
  "getIssue",
  "updateIssue",
  "deleteIssue",
  "addComment",
  "getTransitions",
  "transitionIssue",
  "search",
];

/**
 * Parses a configured value into a Jira fields object.
 *
 * Accepts an object or a JSON object string; empty values yield `undefined`
 * and anything else raises the supplied error code.
 *
 * @param value - Raw field input from the node configuration.
 * @param code - `GraphExecutionError` code used when the value is invalid.
 * @param label - Field label included in the error message.
 * @returns The parsed fields object, or `undefined` when the value is empty.
 * @throws {GraphExecutionError} with the supplied `code` when the value is not an object or JSON object.
 */
function parseObjectField(
  value: unknown,
  code: string,
  label: string
): Record<string, unknown> | undefined {
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
      `Jira ${label} must be a JSON object`,
      code
    );
  }
  const record = asRecord(value);
  if (record) return record;
  throw new GraphExecutionError(`Jira ${label} must be a JSON object`, code);
}

/**
 * Jira node (`core.io.jira`): issue, comment, workflow, and JQL operations
 * through the Decaf `JiraService`.
 */
@node("core.io.jira", {
  kind: "core.io.jira",
  category: "IO",
  color: "#0052cc",
  icon: "ti-brand-jira",
  width: 96,
  height: 96,
  labels: ["io", "jira", "issues", "atlassian", "project"],
  metadata: {
    title: "graph.node.io.jira.name",
    description: "graph.node.io.jira.description",
  },
})
@model()
export class JiraNode extends GraphNode<JiraNodeInput, JiraNodeOutput> {
  /**
   * Executes the configured Jira operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `jira` credential supplies the token, username, and base URL.
   * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result` and the affected `issueKey` where available.
   * @throws {GraphExecutionError} with codes `GRAPH_JIRA_OPERATION_REQUIRED` (no operation configured), `GRAPH_JIRA_CREATE_REQUIRED`/`GRAPH_JIRA_ISSUE_REQUIRED`/`GRAPH_JIRA_FIELDS_REQUIRED`/`GRAPH_JIRA_COMMENT_REQUIRED`/`GRAPH_JIRA_TRANSITION_REQUIRED`/`GRAPH_JIRA_SEARCH_REQUIRED` (missing per-operation inputs), `GRAPH_JIRA_FIELDS_INVALID` (malformed fields), or `GRAPH_JIRA_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<JiraNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "Jira node requires an operation",
        "GRAPH_JIRA_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "createIssue";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "jira",
      false,
      "Jira"
    );
    const service = new JiraService();
    try {
      await bootWithoutEnvironment(service, {
        token: credentialValue(secret, "token", "Jira"),
        username: credentialValue(secret, "username", "Jira"),
        baseUrl: this.baseUrl ?? credentialValue(secret, "baseUrl", "Jira"),
      });
      switch (operation) {
        case "createIssue": {
          if (!this.projectKey || !this.summary) {
            throw new GraphExecutionError(
              "Jira createIssue requires projectKey and summary",
              "GRAPH_JIRA_CREATE_REQUIRED"
            );
          }
          const result = await service.createIssue({
            projectKey: this.projectKey,
            summary: this.summary,
            issueType: this.issueType,
            description: this.description,
            fields: parseObjectField(
              this.fields,
              "GRAPH_JIRA_FIELDS_INVALID",
              "fields"
            ),
          });
          const record = asRecord(result);
          return {
            result,
            ...(typeof record?.key === "string"
              ? { issueKey: record.key }
              : {}),
          };
        }
        case "getIssue": {
          if (!this.issueKey) {
            throw new GraphExecutionError(
              "Jira getIssue requires an issueKey",
              "GRAPH_JIRA_ISSUE_REQUIRED"
            );
          }
          return {
            result: await service.getIssue(this.issueKey),
            issueKey: this.issueKey,
          };
        }
        case "updateIssue": {
          if (!this.issueKey) {
            throw new GraphExecutionError(
              "Jira updateIssue requires an issueKey",
              "GRAPH_JIRA_ISSUE_REQUIRED"
            );
          }
          const fields = parseObjectField(
            this.fields,
            "GRAPH_JIRA_FIELDS_REQUIRED",
            "fields"
          );
          if (!fields) {
            throw new GraphExecutionError(
              "Jira updateIssue requires fields",
              "GRAPH_JIRA_FIELDS_REQUIRED"
            );
          }
          return {
            result: await service.updateIssue({
              issueKey: this.issueKey,
              fields,
            }),
            issueKey: this.issueKey,
          };
        }
        case "deleteIssue": {
          if (!this.issueKey) {
            throw new GraphExecutionError(
              "Jira deleteIssue requires an issueKey",
              "GRAPH_JIRA_ISSUE_REQUIRED"
            );
          }
          return {
            result: await service.deleteIssue(this.issueKey),
            issueKey: this.issueKey,
          };
        }
        case "addComment": {
          if (!this.issueKey || !this.comment) {
            throw new GraphExecutionError(
              "Jira addComment requires issueKey and comment",
              "GRAPH_JIRA_COMMENT_REQUIRED"
            );
          }
          return {
            result: await service.addComment({
              issueKey: this.issueKey,
              body: this.comment,
            }),
            issueKey: this.issueKey,
          };
        }
        case "getTransitions": {
          if (!this.issueKey) {
            throw new GraphExecutionError(
              "Jira getTransitions requires an issueKey",
              "GRAPH_JIRA_ISSUE_REQUIRED"
            );
          }
          return {
            result: await service.getTransitions(this.issueKey),
            issueKey: this.issueKey,
          };
        }
        case "transitionIssue": {
          if (!this.issueKey || !this.transitionId) {
            throw new GraphExecutionError(
              "Jira transitionIssue requires issueKey and transitionId",
              "GRAPH_JIRA_TRANSITION_REQUIRED"
            );
          }
          return {
            result: await service.transitionIssue({
              issueKey: this.issueKey,
              transitionId: this.transitionId,
            }),
            issueKey: this.issueKey,
          };
        }
        default: {
          if (!this.jql) {
            throw new GraphExecutionError(
              "Jira search requires a jql query",
              "GRAPH_JIRA_SEARCH_REQUIRED"
            );
          }
          return {
            result: await service.search({
              jql: this.jql,
              maxResults: asNumber(this.maxResults),
            }),
          };
        }
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Jira node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_JIRA_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Jira operation to perform (default `createIssue`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: JiraOperation = "createIssue";

  /** Project key used by `createIssue`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.projectKey.label",
    type: "string",
  })
  @input({ handle: "projectKey", userControlled: true })
  projectKey?: string;

  /** Issue type name (default `Task`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.issueType.label",
    type: "string",
  })
  @input({ handle: "issueType", userControlled: true })
  issueType?: string;

  /** Issue summary used by `createIssue`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.summary.label",
    type: "string",
  })
  @input({ handle: "summary", userControlled: true })
  summary?: string;

  /** Issue description used by `createIssue`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.description.label",
    type: "textarea",
  })
  @input({ handle: "description", userControlled: true })
  description?: string;

  /** Issue key used by get/update/delete/comment/transition operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.issueKey.label",
    type: "string",
  })
  @input({ handle: "issueKey", userControlled: true })
  issueKey?: string;

  /** Additional Jira fields as an object or JSON string. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.fields.label",
    type: "textarea",
  })
  @input({ handle: "fields", userControlled: true })
  fields?: unknown;

  /** Comment body used by `addComment`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.comment.label",
    type: "textarea",
  })
  @input({ handle: "comment", userControlled: true })
  comment?: string;

  /** Workflow transition ID used by `transitionIssue`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.transitionId.label",
    type: "string",
  })
  @input({ handle: "transitionId", userControlled: true })
  transitionId?: string;

  /** JQL query used by `search`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.jql.label",
    type: "string",
  })
  @input({ handle: "jql", userControlled: true })
  jql?: string;

  /** Maximum results returned by `search`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.maxResults.label",
    type: "number",
  })
  @input({ handle: "maxResults", userControlled: true })
  maxResults?: number;

  /** Optional Jira site base URL (overrides the credential value). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.jira.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Affected issue key. */
  @output({ handle: "issueKey", type: "string" })
  resultIssueKey?: string;
}
