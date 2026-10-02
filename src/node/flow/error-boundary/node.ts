/**
 * @module as-graph/nodes/flow/error-boundary
 * @summary Error-boundary flow-control node declaration (DECAF-32 §22.2.2).
 * @description Error boundary — try/catch/finally workflow behaviour.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import {
  GraphExecutionStatus,
  type GraphExecutionErrorPayload,
} from "../../../shared/graph";
import { GraphNode } from "../../base";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";

/** Inputs accepted by the error-boundary node. */
export type ErrorBoundaryFlowInput = Record<string, unknown>;

/** Outputs produced by the error-boundary node. */
export interface ErrorBoundaryFlowOutput {
  result: unknown;
  error: unknown;
}

/**
 * Normalises a thrown value into a JSON-safe {@link GraphExecutionErrorPayload}.
 */
function errorPayloadOf(error: unknown): GraphExecutionErrorPayload {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code:
        (error as { graphCode?: string }).graphCode ??
        (typeof (error as { code?: unknown }).code === "number"
          ? String((error as { code?: unknown }).code)
          : ((error as { code?: string }).code as string | undefined)),
    };
  }
  return { name: "UnknownError", message: String(error) };
}

/**
 * Error-boundary flow-control node: try/catch/finally workflow behaviour.
 *
 * The guarded `try` body, and the optional `catch`/`finally` bodies, live on the
 * node instance's `errorBoundary` configuration. The boundary emits `result` when
 * the try body succeeds and `error` when it fails; the two outputs are
 * mutually exclusive, so neither is `@required()`. When no body is configured the
 * node is a pass-through of its `value` input.
 */
@node("core.flow.errorBoundary", {
  kind: "core.flow.errorBoundary",
  category: "Flow Control",
  color: "#f59e0b",
  icon: "ti-shield-check",
  width: 96,
  height: 96,
  labels: ["flow", "error", "try-catch"],
  metadata: {
    title: "graph.node.flow_control.error_boundary.name",
    description:
      "graph.node.flow_control.error_boundary.description",
    finally: false,
  },
})
@model()
export class ErrorBoundaryFlowNode extends GraphNode<
  ErrorBoundaryFlowInput,
  ErrorBoundaryFlowOutput
> {
  /**
   * Executes the configured `try` body as a child run and routes its output
   * to `result`; on failure runs the optional `catch` body (receiving a
   * JSON-safe error payload) and routes to `error`, always running the
   * optional `finally` body. Without a `try` body the node passes its
   * `value` input through.
   *
   * @param {GraphNodeExecutionRequest<ErrorBoundaryFlowInput>} request - Execution request carrying the `value` input.
   * @param {GraphExecutionContext} context - Execution context providing the `errorBoundary` configuration and engine access.
   * @return {Promise<GraphExecutionValues>} The try body output under `result`, or the caught value under `error`.
   * @throws {GraphExecutionError} When the try body fails without a `catch` body, or when the context exposes no engine.
   */
  override async execute(
    request: GraphNodeExecutionRequest<ErrorBoundaryFlowInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const config = context.node.errorBoundary;
    if (!config?.try) {
      return { result: request.inputs["value"] ?? request.inputs };
    }

    const engine = context.engine;
    if (!engine) {
      throw new GraphExecutionError(
        "errorBoundary node requires engine access",
        "GRAPH_ENGINE_NOT_AVAILABLE"
      );
    }

    try {
      const child = await engine.execute(config.try, request.inputs, {
        parentRunId: context.runId,
        path: [...context.path, "try"],
      });
      const failure = Object.values(child.nodeResults).find(
        (result) => result.status === GraphExecutionStatus.FAILED
      );
      if (failure) {
        throw new GraphExecutionError(
          failure.error?.message ?? "error boundary try body failed",
          failure.error?.code ?? "GRAPH_ERROR_BOUNDARY",
          failure.error?.details
        );
      }
      return { result: child.outputs["result"] ?? child.outputs };
    } catch (error) {
      let caught: unknown = error;
      if (config.catch) {
        const catchRun = await engine.execute(
          config.catch,
          { ...request.inputs, error: errorPayloadOf(error) },
          { parentRunId: context.runId, path: [...context.path, "catch"] }
        );
        caught = catchRun.outputs["error"] ?? catchRun.outputs;
      }
      return { error: caught };
    } finally {
      if (config.finally) {
        await engine.execute(config.finally, request.inputs, {
          parentRunId: context.runId,
          path: [...context.path, "finally"],
        });
      }
    }
  }

  /** Value passed through untouched when no `try` body is configured. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.error_boundary.fields.value.label",
    placeholder: "graph.node.flow_control.error_boundary.fields.value.placeholder",
    type: "textarea",
  })
  @input({ handle: "value" })
  value!: unknown;

  /** Output carrying the try body's output when execution succeeds. */
  @output({ handle: "result" })
  result!: unknown;

  /** Output carrying the caught value when the try body fails and `catch` handles it. */
  @output({ handle: "error" })
  error!: unknown;
}
