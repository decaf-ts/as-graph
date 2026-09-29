/**
 * @module as-graph/nodes/utility/utility-log
 * @summary Utility Log node declaration (DECAF-48 §4.3).
 * @description Utility Log — logs the input value through the run's
 * `ctx.logger` at a configurable level and forwards it unchanged on the
 * `logged` output port.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../shared/graph";
import type { LogNodeLevel } from "../../shared/graph";
import type { GraphExecutionContext } from "../../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";
import { GraphNode } from "../base";

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
    title: "Utility Log",
    description:
      "Logs the input value to the run's ctx.logger at a configurable level and forwards it unchanged.",
  },
})
@model()
export class UtilityLogNode extends GraphNode {
  static override execute(
    request: GraphNodeExecutionRequest,
    context: GraphExecutionContext
  ): GraphExecutionValues {
    const value = request.inputs["value"];
    const parameters = (context.node.parameters ?? {}) as Record<
      string,
      unknown
    >;
    const metadata = context.node.metadata as
      | Record<string, unknown>
      | undefined;
    const level =
      ((parameters["level"] ?? metadata?.["level"]) as LogNodeLevel) || "info";
    const logger = context.logger as unknown as Record<
      LogNodeLevel,
      (message: string, meta?: Record<string, unknown>) => void
    >;
    logger[level]("Log node", { value });
    return { logged: value };
  }

  @required()
  @uielement("textarea", { label: "Input value", placeholder: "Value to log" })
  @input({ handle: "value" })
  value!: unknown;

  @uielement("input", {
    label: "Log level",
    placeholder: "info, warn, error, ...",
  })
  level!: LogNodeLevel;

  @required()
  @uielement("input", { label: "Logged value", placeholder: "Forwarded value" })
  @output({ handle: "logged" })
  logged!: unknown;
}
