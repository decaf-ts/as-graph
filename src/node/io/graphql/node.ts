/**
 * @module as-graph/nodes/io/graphql
 * @summary GraphQL IO node declaration (Stage 3b; `core.io.graphql`).
 * @description GraphQL — run a GraphQL query or mutation against a GraphQL
 * endpoint through the Decaf `GraphqlService`. The query document comes from
 * `query` (falling back to the `value` input); optional `variables` (an object)
 * and `operationName` are passed through. The `graphql` credential (resolved
 * through the ctx-bound node credential resolver) is a JSON object
 * carrying `endpoint` and/or `token` (node config wins for `endpoint`); both
 * are optional. GraphQL-level errors (`response.errors`) are not thrown — they
 * are reported on the `errors` output alongside any partial `data`; transport
 * failures throw. An unknown `operation` silently falls back to `query`. A
 * throwaway `GraphqlService` is initialized per execution and shut down in a
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
import { GraphqlService } from "@decaf-ts/integrations/io/graphql";
import { bootWithoutEnvironment } from "@decaf-ts/integrations/shared/http";
import {
  asRecord,
  resolveNodeCredential,
} from "../../storage/support";
import { credentialValue } from "../../credentials";

/** Operations the node can run against a GraphQL endpoint. */
export type GraphqlOperation = "query" | "mutation";

/** Inputs accepted by the GraphQL node (the optional `value` input supplies the query document). */
export type GraphqlNodeInput = Record<string, unknown>;

/** Outputs produced by the GraphQL node: the response data plus GraphQL-level errors when present. */
export interface GraphqlNodeOutput {
  result: unknown;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
}

/** All supported operations; unknown configured values fall back to `query`. */
const OPERATIONS: GraphqlOperation[] = ["query", "mutation"];

/**
 * GraphQL IO node: query/mutation execution through `GraphqlService`.
 */
@node("core.io.graphql", {
  kind: "core.io.graphql",
  category: "IO",
  color: "#e10098",
  icon: "ti-api",
  width: 96,
  height: 96,
  labels: ["io", "graphql", "api", "query"],
  metadata: {
    title: "graph.node.io.graphql.name",
    description: "graph.node.io.graphql.description",
  },
})
@model()
export class GraphqlNode extends GraphNode<
  GraphqlNodeInput,
  GraphqlNodeOutput
> {
  /**
   * Executes the configured GraphQL operation.
   *
   * @param request - Execution request carrying the credential secrets and the optional `value` query fallback.
    * @param context - Node execution context forwarded to the ctx-bound credential resolver.
   * @returns The response `data` on `result`; GraphQL-level errors are emitted on the `errors` output instead of throwing.
   * @throws {GraphExecutionError} with codes `GRAPH_GRAPHQL_OPERATION_REQUIRED` (no operation configured), `GRAPH_GRAPHQL_QUERY_REQUIRED` (no query document), `GRAPH_CREDENTIAL_*` codes from credential resolution, or `GRAPH_GRAPHQL_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<GraphqlNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.operation) {
      throw new GraphExecutionError(
        "GraphQL node requires an operation",
        "GRAPH_GRAPHQL_OPERATION_REQUIRED"
      );
    }
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "query";
    const query = this.query ?? String(request.inputs["value"] ?? "");
    if (!query) {
      throw new GraphExecutionError(
        "GraphQL node requires a query document",
        "GRAPH_GRAPHQL_QUERY_REQUIRED"
      );
    }
    const secret = await resolveNodeCredential(
      context,
      request.credentials,
      "graphql",
      false,
      "GraphQL"
    );
    const service = new GraphqlService();
    try {
      await bootWithoutEnvironment(service, {
        endpoint:
          this.endpoint ??
          credentialValue(secret, "endpoint", "GraphQL"),
        token: credentialValue(secret, "token", "GraphQL"),
      });
      const response = await service.request({
        query,
        variables: asRecord(this.variables),
        operationName: this.operationName,
      });
      if (response.errors && response.errors.length > 0) {
        return {
          result: response.data,
          errors: response.errors,
        };
      }
      return { result: response.data };
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `GraphQL node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_GRAPHQL_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Operation to run (default `query`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.graphql.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: GraphqlOperation = "query";

  /** GraphQL endpoint URL (falls back to the credential). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.graphql.fields.endpoint.label",
    type: "string",
  })
  @input({ handle: "endpoint", userControlled: true })
  endpoint?: string;

  /** Query or mutation document (falls back to the `value` input). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.graphql.fields.query.label",
    type: "textarea",
  })
  @input({ handle: "query", userControlled: true })
  query?: string;

  /** Optional GraphQL variables object. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.graphql.fields.variables.label",
    type: "json",
  })
  @input({ handle: "variables", userControlled: true })
  variables?: Record<string, unknown>;

  /** Optional name of the operation to run within the document. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.graphql.fields.operationName.label",
    type: "string",
  })
  @input({ handle: "operationName", userControlled: true })
  operationName?: string;

  /** Response `data` (partial data is still emitted when GraphQL errors are reported). */
  @output({ handle: "result" })
  result!: unknown;

  /** GraphQL-level errors reported by the endpoint (not thrown). */
  @output({ handle: "errors", type: "array" })
  errors?: Array<{ message: string; path?: Array<string | number> }>;
}
