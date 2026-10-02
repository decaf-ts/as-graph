/**
 * @module as-graph/nodes/utility/utility-log
 * @summary Utility Log node declaration (DECAF-48 §4.3).
 * @description Utility Log — logs the input value through the run's
 * `ctx.logger` at a configurable level and forwards it unchanged on the
 * `value` output port. The logged `value` is a plain canvas port (not a
 * `@uielement`); the `message` and `level` properties are the
 * `@uielement` configuration fields. There is no `logged` property.
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

/** Inputs accepted by the utility-log node. */
export type UtilityLogInput = Record<string, unknown>;

/** Outputs produced by the utility-log node. */
export interface UtilityLogOutput {
  value: unknown;
}

/**
 * Utility Log node: logs the input through the run's `ctx.logger` at a configurable level and forwards it unchanged.
 */
@node("core.utility.log", {
  kind: "core.utility.log",
  category: "Utility",
  color: "#0d9488",
  icon: "ti-terminal",
  width: 96,
  height: 96,
  labels: ["utility", "log", "debug", "observability"],
  metadata: {
    title: "graph.node.utility.utility_log.name",
    description:
      "graph.node.utility.utility_log.description",
  },
})
@model()
export class UtilityLogNode extends GraphNode<
  UtilityLogInput,
  UtilityLogOutput
> {
  /**
   * Logs the `value` input through the run's `ctx.logger` at the configured
   * level and forwards it unchanged.
   *
   * @param {GraphNodeExecutionRequest<UtilityLogInput>} request - Execution request carrying the `value` input.
   * @param {GraphExecutionContext} context - Execution context providing the run logger.
   * @return {GraphExecutionValues} The unchanged input value under `value`.
   */
  override execute(
    request: GraphNodeExecutionRequest<UtilityLogInput>,
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
    label: "graph.node.utility.utility_log.fields.message.label",
    placeholder: "graph.node.utility.utility_log.fields.message.placeholder",
    type: "textarea",
  })
  @input({ handle: "message" })
  message?: string;

  /** Log level used for the entry; defaults to `info`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.utility.utility_log.fields.level.label",
    placeholder: "graph.node.utility.utility_log.fields.level.placeholder",
  })
  @input({ handle: "level", userControlled: true, type: "string" })
  level?: LogNodeLevel;

  /** Output carrying the unchanged input value. */
  @required()
  @output({ handle: "value" })
  valueOut!: unknown;
}
