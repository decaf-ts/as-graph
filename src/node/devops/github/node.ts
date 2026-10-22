/**
 * @module as-graph/nodes/devops/github
 * @summary GitHub DevOps node declaration (Stage 3b; `core.devops.github`).
 * @description GitHub — repository lookup, issue listing/creation/commenting,
 * and pull-request listing through the Decaf `GithubService`. The `github`
 * credential (a bare personal-access token, resolved through the ctx-bound
 * node credential resolver) is optional only in the sense
 * that the service may operate on public repositories without it; tokenized
 * API access requires it. `owner` and `repo` scope every operation; `getRepo`
 * and unknown operations (falling back to `getRepo`) only need them, while
 * `createIssue` requires a `title` (body falls back to the `value` input) and
 * `commentIssue` requires an issue `number` and `body`. A throwaway
 * `GithubService` is initialized per execution and shut down in a `finally`
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
import { GithubService } from "@decaf-ts/integrations/devops/github";
import { bootWithoutEnvironment } from "@decaf-ts/integrations/shared/http";
import {
  asNumber,
  asStringArray,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialToken } from "../../credentials";

/** Operation the node performs against the GitHub API. */
export type GithubOperation =
  | "getRepo"
  | "listIssues"
  | "createIssue"
  | "commentIssue"
  | "listPullRequests";

/** Inputs accepted by the GitHub node. */
export type GithubNodeInput = Record<string, unknown>;

/** Outputs produced by the GitHub node. */
export interface GithubNodeOutput {
  /** Raw service response for the executed operation. */
  result: unknown;
  /** Created/commented issue number (present for `createIssue`/`commentIssue`). */
  number?: number;
  /** Web URL of the created/commented issue (present for `createIssue`/`commentIssue`). */
  url?: string;
}

/** Supported operations; unknown configured values fall back to `getRepo`. */
const OPERATIONS: GithubOperation[] = [
  "getRepo",
  "listIssues",
  "createIssue",
  "commentIssue",
  "listPullRequests",
];

/**
 * GitHub node (`core.devops.github`): repository, issue, and pull-request
 * operations through the Decaf `GithubService`.
 */
@node("core.devops.github", {
  kind: "core.devops.github",
  category: "DevOps",
  color: "#24292f",
  icon: "ti-brand-github",
  width: 96,
  height: 96,
  labels: ["devops", "github", "git", "issues"],
  metadata: {
    title: "graph.node.devops.github.name",
    description: "graph.node.devops.github.description",
  },
})
@model()
export class GithubNode extends GraphNode<GithubNodeInput, GithubNodeOutput> {
  /**
   * Executes the configured GitHub operation.
   *
   * @param request - Execution request carrying the credential secrets; the optional `github` token is resolved via `resolveNodeCredential`.
    * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns Execution values with the service response on `result` and, for issue writes, the `number` and `url` outputs.
   * @throws {GraphExecutionError} with codes `GRAPH_GITHUB_OPERATION_REQUIRED` (no operation configured), `GRAPH_GITHUB_TITLE_REQUIRED`/`GRAPH_GITHUB_COMMENT_REQUIRED` (missing per-operation inputs), or `GRAPH_GITHUB_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<GithubNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "GitHub node requires an operation",
        "GRAPH_GITHUB_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "getRepo";
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "github",
      false,
      "GitHub"
    );
    const service = new GithubService();
    try {
      await bootWithoutEnvironment(service, {
        token: credentialToken(secret, "GitHub"),
        owner: this.owner,
        repo: this.repo,
        baseUrl: this.baseUrl,
      });
      switch (operation) {
        case "getRepo":
          return {
            result: await service.getRepository({
              owner: this.owner,
              repo: this.repo,
            }),
          };
        case "listIssues":
          return {
            result: await service.listIssues({
              owner: this.owner,
              repo: this.repo,
              state: this.state,
              limit: asNumber(this.limit),
              page: asNumber(this.page),
              labels: this.labels?.join(","),
            }),
          };
        case "createIssue": {
          if (!this.title) {
            throw new GraphExecutionError(
              "GitHub createIssue requires a title",
              "GRAPH_GITHUB_TITLE_REQUIRED"
            );
          }
          const result = await service.createIssue({
            owner: this.owner,
            repo: this.repo,
            title: this.title,
            body: this.body ?? String(request.inputs["value"] ?? ""),
            labels: asStringArray(this.labels)?.map(String),
            assignees: asStringArray(this.assignees)?.map(String),
          });
          return {
            result,
            number: result.number,
            url: result.htmlUrl,
          };
        }
        case "commentIssue": {
          const number = asNumber(this.number);
          if (!number || !this.body) {
            throw new GraphExecutionError(
              "GitHub commentIssue requires an issue number and body",
              "GRAPH_GITHUB_COMMENT_REQUIRED"
            );
          }
          const result = await service.commentOnIssue({
            owner: this.owner,
            repo: this.repo,
            number,
            body: this.body,
          });
          return { result, number, url: result.htmlUrl };
        }
        default:
          return {
            result: await service.listPullRequests({
              owner: this.owner,
              repo: this.repo,
              state: this.state,
              limit: asNumber(this.limit),
              page: asNumber(this.page),
            }),
          };
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `GitHub node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_GITHUB_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** GitHub operation to perform (default `getRepo`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.github.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: GithubOperation = "getRepo";

  /** Repository owner (required by every operation). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.github.fields.owner.label",
    type: "string",
  })
  @input({ handle: "owner", userControlled: true })
  owner?: string;

  /** Repository name (required by every operation). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.github.fields.repo.label",
    type: "string",
  })
  @input({ handle: "repo", userControlled: true })
  repo?: string;

  /** Issue number to comment on (`commentIssue` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.github.fields.number.label",
    type: "number",
  })
  @input({ handle: "number", userControlled: true })
  number?: number;

  /** New issue title (`createIssue` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.common.fields.title.label",
    type: "string",
  })
  @input({ handle: "title", userControlled: true })
  title?: string;

  /** Issue body or comment text (falls back to the `value` input for `createIssue`). */
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

  /** Usernames to assign to the new issue (`createIssue` only). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.github.fields.assignees.label",
    type: "json",
  })
  @input({ handle: "assignees", userControlled: true })
  assignees?: string[];

  /** Issue/pull-request state filter for list operations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.common.fields.state.label",
    type: "select",
  })
  @input({ handle: "state", userControlled: true })
  state?: "open" | "closed" | "all";

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

  /** Optional API base URL override (GitHub Enterprise). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.common.fields.baseUrl.label",
    type: "string",
  })
  @input({ handle: "baseUrl", userControlled: true })
  baseUrl?: string;

  /** Raw service response for the executed operation. */
  @output({ handle: "result" })
  result!: unknown;

  /** Issue number (issue write operations only). */
  @output({ handle: "number", type: "number" })
  issueNumber?: number;

  /** Web URL of the created/commented issue (issue write operations only). */
  @output({ handle: "url", type: "string" })
  url?: string;
}
