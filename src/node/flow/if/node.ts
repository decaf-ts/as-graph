/**
 * @module as-graph/nodes/flow/if
 * @summary If flow-control node declaration (DECAF-32 §22.2.2).
 * @description If — conditional branch. Evaluates a `ConditionExpression`
 * (§22.3) and routes the input to the `then` or `else` output. The `else`
 * branch is opt-in: it is rendered in CRUD as a boolean and the `else` output
 * port is only exposed (see `ifManifest` in `../../manifests`) when that boolean
 * is `true`. When the condition is `false` and the `else` branch is disabled,
 * execution throws — equivalent to wiring a true `else` into an exception node
 * with the default message.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import type { ConditionExpression } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { ConditionExpressionEvaluator } from "../../../engine/loops/ConditionExpressionEvaluator";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";

/** Inputs accepted by the if node. */
export type IfFlowInput = Record<string, unknown>;

/** Outputs produced by the if node. */
export interface IfFlowOutput {
  then: unknown;
  else: unknown;
}

/**
 * Builds the state a `ConditionExpression` is resolved against, unwrapping the
 * `value` port but merging the full input map so a path may reference either the
 * primary value or any input port.
 */
function ifConditionState(
  input: GraphExecutionValues,
  inputValue: unknown
): unknown {
  if (inputValue === input) return input;
  if (
    typeof inputValue === "object" &&
    inputValue !== null &&
    !Array.isArray(inputValue)
  ) {
    return { ...(inputValue as Record<string, unknown>), ...input };
  }
  return input;
}

/**
 * If flow-control node: evaluates a condition and routes the input to the `then` or
 * `else` output.
 */
@node("core.flow.if", {
  kind: "core.flow.if",
  category: "Flow Control",
  color: "#f59e0b",
  icon: "ti-arrows-split-2",
  width: 96,
  height: 96,
  labels: ["flow", "conditional", "branch"],
  metadata: {
    title: "graph.node.flow_control.if.name",
    description:
      "graph.node.flow_control.if.description",
  },
})
@model()
export class IfFlowNode extends GraphNode<IfFlowInput, IfFlowOutput> {
  /**
   * Evaluates the configured `ConditionExpression` against the resolved
   * condition state and routes the input value to `then` or `else`; throws
   * when the condition is false and the `else` branch is disabled.
   *
   * @param {GraphNodeExecutionRequest<IfFlowInput>} request - Execution request carrying the `value` input.
   * @return {GraphExecutionValues} The routed input value under `then` or `else`.
   * @throws {GraphExecutionError} When no condition is configured (`GRAPH_IF_NO_CONDITION`) or when the condition is false with `else` disabled (`GRAPH_IF_ELSE_DISABLED`).
   */
  override execute(
    request: GraphNodeExecutionRequest<IfFlowInput>
  ): GraphExecutionValues {
    const input = request.inputs;
    const inputValue = input["value"] ?? input;

    if (!this.condition) {
      throw new GraphExecutionError(
        "If node has no condition configured",
        "GRAPH_IF_NO_CONDITION",
        { input }
      );
    }

    const matched = new ConditionExpressionEvaluator().evaluate(
      this.condition,
      ifConditionState(input, inputValue)
    );
    if (matched) {
      return { then: inputValue };
    }

    if (this.else === true) {
      return { else: inputValue };
    }

    throw new GraphExecutionError(
      "If node condition evaluated to false and the else branch is disabled",
      "GRAPH_IF_ELSE_DISABLED",
      { condition: this.condition }
    );
  }

  /** Primary input value routed to the `then` or `else` output. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.if.fields.value.label",
    placeholder: "graph.node.flow_control.if.fields.value.placeholder",
    type: "textarea",
  })
  @input({ handle: "value" })
  value!: unknown;

  /** Output carrying the input value when the condition evaluates truthy. */
  @required()
  @output({ handle: "then" })
  then!: unknown;

  /** Condition expression (§22.3) evaluated against the resolved condition state. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.if.fields.condition.label",
    placeholder: "graph.node.flow_control.if.fields.condition.placeholder",
    type: "code",
  })
  @input({ handle: "condition", userControlled: true, type: "object" })
  condition?: ConditionExpression;

  /** Enables the `else` output branch; when false, a failed condition throws. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.if.fields.else.label",
    type: "checkbox",
  })
  @input({ handle: "else", userControlled: true })
  else?: boolean;
}
