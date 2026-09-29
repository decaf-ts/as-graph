/**
 * @module as-graph/nodes/utility/log
 * @summary Log utility node declaration (DECAF-32 §22.2.2).
 * @description Log — logs the input value and forwards it unchanged on the
 * `logged` output port. Useful for debugging, audit trails, and
 * discard/side-effect branches in a workflow.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import {
  input,
  node,
  output,
  LogNodeLevel,
} from "../../shared/graph";
import type { GraphExecutionContext } from "../../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";
import { GraphNode } from "../base";

/**
 * Log utility node: logs the input value and forwards it unchanged on the `logged` output.
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
    title: "Log",
    description:
      "Logs the input value to the execution logger and forwards it unchanged.",
  },
})
@model()
export class LogFlowNode extends GraphNode {
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

  @required()
  @uielement("input", { label: "Logged value", placeholder: "Forwarded value" })
  @output({ handle: "logged" })
  logged!: unknown;
}
