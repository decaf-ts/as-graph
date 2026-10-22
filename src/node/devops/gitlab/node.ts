/**
 * @module as-graph/nodes/devops/gitlab
 * @summary GitLab DevOps node declaration (Stage 3b; `core.devops.gitlab`).
 * @description GitLab — project lookup, issue listing/creation/commenting, and
 * merge-request listing through the Decaf `GitlabService`. The `gitlab`
 * credential (a bare personal-access token, resolved through the ctx-bound
 * node credential resolver) is optional; public projects can
 * be read without it. `projectId` scopes every operation; `getProject` and
 * unknown operations (falling back to `getProject`) only need it, while
 * `createIssue` requires a `title` (description falls back to the `value`
 * input) and `commentIssue` requires an issue `iid` and `body`. A throwaway
 * `GitlabService` is initialized per execution and shut down in a `finally`
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
import { GitlabService } from "@decaf-ts/integrations/devops/gitlab";
import {
  asNumber,
  asStringArray,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialToken } from "../../credentials";

/** Operation the node performs against the GitLab API. */
export type GitlabOperation =
  | "getProject"
  | "listIssues"
  | "createIssue"
  | "commentIssue"
  | "listMergeRequests";

/** Inputs accepted by the GitLab node. */
export type GitlabNodeInput = Record<string, unknown>;

/** Outputs produced by the GitLab node. */
export interface GitlabNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Created/commented issue internal id (present for `createIssue`/`commentIssue`). */
  iid?: number;
  /** Web URL of the created/commented issue (present for `createIssue`/`commentIssue`). */
  url?: string;
}

/** Supported operations; unknown configured values fall back to `getProject`. */
const OPERATIONS: GitlabOperation[] = [
  "getProject",
  "listIssues",
  "createIssue",
  "commentIssue",
  "listMergeRequests",
];

/**
 * GitLab node (`core.devops.gitlab`): project, issue, and merge-request
 * operations through the Decaf `GitlabService`.
 */
@node("core.devops.gitlab", {
  kind: "core.devops.gitlab",
  category: "DevOps",
  color: "#fc6d26",
  icon: "ti-brand-gitlab",
  width: 96,
  height: 96,
  labels: ["devops", "gitlab", "git", "issues"],
  metadata: {
    title: "graph.node.devops.gitlab.name",
    description: "graph.node.devops.gitlab.description",
  },
})
@model()
export class GitlabNode extends GraphNode<GitlabNodeInput, GitlabNodeOutput> {
  /**
   * Executes the configured GitLab operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `gitlab` token is resolved via `resolveNodeCredential`.
    * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result` and, for issue writes, the `iid` and `url` outputs.
   * @throws {GraphExecutionError} with codes `GRAPH_GITLAB_OPERATION_REQUIRED` (no operation configured), `GRAPH_GITLAB_TITLE_REQUIRED`/`GRAPH_GITLAB_COMMENT_REQUIRED` (missing per-operation inputs), or `GRAPH_GITLAB_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<GitlabNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "GitLab node requires an operation",
        "GRAPH_GITLAB_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "getProject";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "gitlab",
      false,
      "GitLab"
    );
    const service = new GitlabService();
    try {
      await service.boot({
        token: credentialToken(secret, "GitLab"),
        projectId: this.projectId,
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "getProject":
          return { result: await service.getProject(this.projectId) };
        case "listIssues":
          return {
            result: await service.listIssues({
              projectId: this.projectId,
              state: this.state,
              limit: asNumber(this.limit),
              page: asNumber(this.page),
              labels: asStringArray(this.labels)?.map(String).join(","),
              search: this.search,
            }),
          };
        case "createIssue": {
          if (!this.title) {
            throw new GraphExecutionError(
              "GitLab createIssue requires a title",
              "GRAPH_GITLAB_TITLE_REQUIRED"
            );
          }
          const result = await service.createIssue({
            projectId: this.projectId,
            title: this.title,
            description: this.body ?? String(request.inputs["value"] ?? ""),
            labels: asStringArray(this.labels)?.map(String).join(","),
            assigneeIds: asStringArray(this.assigneeIds)?.map(Number),
          });
          return {
            result,
            iid: result.iid,
            url: result.webUrl,
          };
        }
        case "commentIssue": {
          const iid = asNumber(this.iid);
          if (!iid || !this.body) {
            throw new GraphExecutionError(
              "GitLab commentIssue requires an issue IID and body",
              "GRAPH_GITLAB_COMMENT_REQUIRED"
            );
          }
          const result = await service.commentOnIssue({
            projectId: this.projectId,
            iid,
            body: this.body,
          });
          return { result, iid, url: result.webUrl };
        }
        default:
          return {
            result: await service.listMergeRequests({
              projectId: this.projectId,
              state: this.state,
              limit: asNumber(this.limit),
              page: asNumber(this.page),
              search: this.search,
            }),
          };
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `GitLab node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_GITLAB_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** GitLab operation to perform (default `getProject`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.gitlab.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: GitlabOperation = "getProject";

  /** Numeric project id or URL-encoded path (required by every operation). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.gitlab.fields.projectId.label",
    type: "string",
  })
  @input({ handle: "projectId", userControlled: true })
  projectId?: string;

  /** Issue internal id to comment on (`commentIssue` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.gitlab.fields.iid.label",
    type: "number",
  })
  @input({ handle: "iid", userControlled: true })
  iid?: number;

  /** New issue title (`createIssue` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.common.fields.title.label",
    type: "string",
  })
  @input({ handle: "title", userControlled: true })
  title?: string;

  /** Issue description or comment text (falls back to the `value` input for `createIssue`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.common.fields.body.label",
    type: "textarea",
  })
  @input({ handle: "body", userControlled: true })
  body?: string;

  /** Comma-joined label filter (`listIssues`) or applied labels (`createIssue`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.common.fields.labels.label",
    type: "json",
  })
  @input({ handle: "labels", userControlled: true })
  labels?: string[];

  /** Numeric user ids to assign to the new issue (`createIssue` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.gitlab.fields.assigneeIds.label",
    type: "json",
  })
  @input({ handle: "assigneeIds", userControlled: true })
  assigneeIds?: number[];

  /** Issue/merge-request state filter for list operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.common.fields.state.label",
    type: "select",
  })
  @input({ handle: "state", userControlled: true })
  state?: "opened" | "closed" | "all";

  /** Free-text search filter for `listIssues` and `listMergeRequests`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.gitlab.fields.search.label",
    type: "string",
  })
  @input({ handle: "search", userControlled: true })
  search?: string;

  /** Page size for list operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.common.fields.limit.label",
    type: "number",
  })
  @input({ handle: "limit", userControlled: true })
  limit?: number;

  /** 1-based page number for list operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.common.fields.page.label",
    type: "number",
  })
  @input({ handle: "page", userControlled: true })
  page?: number;

  /** Optional API base URL override (self-managed GitLab). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.common.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Issue internal id (issue write operations only). */
  @output({ handle: "iid", type: "number" })
  issueIid?: number;

  /** Web URL of the created/commented issue (issue write operations only). */
  @output({ handle: "url", type: "string" })
  url?: string;
}
