/**
 * @module as-graph/nodes/utility/log
 * @summary Log utility node declaration (DECAF-32 §22.2.2).
 * @description Log — logs the input value and forwards it unchanged on the
 * `value` output port. Useful for debugging, audit trails, and
 * discard/side-effect branches in a workflow. The logged `value` is a plain
 * canvas port (not a `@uielement`); the `message` property is the only
 * `@uielement` configuration field. There is no `logged` property — the node is
 * a passthrough on `value`.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import type { LogNodeLevel } from "../../../shared/graph";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphNode } from "../../base";

/** Inputs accepted by the log node. */
export type LogFlowInput = Record<string, unknown>;

/** Outputs produced by the log node. */
export interface LogFlowOutput {
  value: unknown;
}

/**
 * Log utility node: logs the input value and forwards it unchanged on the `value` output.
 */
@node("core.flow.log", {
  kind: "core.flow.log",
  category: "Utility",
  color: "#0d9488",
  icon: "ti-terminal",
  width: 96,
  height: 96,
  labels: ["flow", "log", "debug", "utility"],
  metadata: {
    title: "graph.node.utility.log.name",
    description:
      "graph.node.utility.log.description",
  },
})
@model()
export class LogFlowNode extends GraphNode<LogFlowInput, LogFlowOutput> {
  /**
   * Logs the `value` input through the run's `ctx.logger` at the configured
   * level and forwards it unchanged.
   *
   * @param {GraphNodeExecutionRequest<LogFlowInput>} request - Execution request carrying the `value` input.
   * @param {GraphExecutionContext} context - Execution context providing the run logger.
   * @return {GraphExecutionValues} The unchanged input value under `value`.
   */
  override execute(
    request: GraphNodeExecutionRequest<LogFlowInput>,
    context: GraphExecutionContext
  ): GraphExecutionValues {
    const value = request.inputs["value"];
    const level = this.level ?? "info";
    const logger = context.logger as unknown as Record<
      LogNodeLevel,
      (message: string, meta?: Record<string, unknown>) => void
    >;
    logger[level](this.message ?? "Log node", { value });
    return { value };
  }

  /** Input value logged and forwarded unchanged. */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Message logged with the value; defaults to `"Log node"`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.utility.log.fields.message.label",
    placeholder: "graph.node.utility.log.fields.message.placeholder",
    type: "textarea",
  })
  @input({ handle: "message" })
  message?: string;

  /** Log level used for the entry; defaults to `info`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.utility.log.fields.level.label",
    placeholder: "graph.node.utility.log.fields.level.placeholder",
    type: "text",
  })
  @input({ handle: "level", userControlled: true })
  level?: LogNodeLevel;

  /** Output carrying the unchanged input value. */
  @required()
  @output({ handle: "value" })
  valueOut!: unknown;
}
