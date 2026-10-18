/**
 * @module as-graph/nodes/data/filter
 * @summary Filter data node declaration (DECAF-746 Data family).
 * @description Filter — keep the input items matching a condition. Each item is
 * evaluated with the shared `ConditionEvaluator` (graphical or code mode, same
 * semantics as the if node): a non-record item is exposed as `item` over the
 * node's inputs, while a record item's fields are spread over the inputs and
 * also exposed as `item`; the item's `index` is always available. The condition
 * result is compared against `negate` — an item is kept when it matches and
 * `negate` is false, or when it fails the condition and `negate` is true. The
 * output is always an array — array-in, array-out.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output, type Condition } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { evaluateCondition } from "../../../engine/loops/ConditionEvaluator";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { asGraphDataArray, isGraphDataRecord } from "../support";

/** Inputs accepted by the Filter node. */
export type FilterNodeInput = Record<string, unknown>;

/** Outputs produced by the Filter node. */
export interface FilterNodeOutput {
  result: unknown[];
}

/**
 * Builds the condition state for one item: the node's inputs, overlaid with the
 * item's own fields when it is a record, with the raw item always available as
 * `item` (so a spread field named `item` cannot shadow it).
 *
 * @param inputs - The node's routed input values.
 * @param item - The item being evaluated.
 * @returns The state the condition resolves against.
 */
function filterStateOf(
  inputs: Record<string, unknown>,
  item: unknown
): Record<string, unknown> {
  if (!isGraphDataRecord(item)) return { ...inputs, item };
  return { ...inputs, ...item, item };
}

/**
 * Filter data node: keeps the input items that satisfy the configured
 * condition, honouring `negate`.
 */
@node("core.data.filter", {
  kind: "core.data.filter",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-filter",
  width: 96,
  height: 96,
  labels: ["data", "filter", "condition"],
  metadata: {
    title: "graph.node.data.filter.name",
    description: "graph.node.data.filter.description",
  },
})
@model()
export class FilterNode extends GraphNode<FilterNodeInput, FilterNodeOutput> {
  /**
   * Evaluates the condition once per input item and keeps the matching ones.
   *
   * @param request - The execution request carrying the `value` input.
   * @param context - The execution context (passed through to the condition
   *   evaluator).
   * @returns The kept items, in input order, under `result`.
   * @throws {GraphExecutionError} with code `GRAPH_FILTER_NO_CONDITION` when
   *   no condition is configured.
   */
  override async execute(
    request: GraphNodeExecutionRequest<FilterNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    if (!this.condition) {
      throw new GraphExecutionError(
        "Filter node has no condition configured",
        "GRAPH_FILTER_NO_CONDITION"
      );
    }

    const items = asGraphDataArray(request.inputs["value"]);
    const result: unknown[] = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const matched = await evaluateCondition(
        this.condition as Condition,
        {
          input: { ...request.inputs, item, index },
          state: filterStateOf(request.inputs, item),
          label: "filter",
        },
        context
      );
      if (matched !== (this.negate === true)) result.push(item);
    }

    return { result };
  }

  @required()
  @input({ handle: "value" })
  value!: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.filter.fields.condition.label",
    placeholder: "graph.node.data.filter.fields.condition.placeholder",
    type: "code",
  })
  @input({ handle: "condition", userControlled: true, type: "object" })
  condition?: Condition;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.filter.fields.negate.label",
    type: "checkbox",
  })
  @input({ handle: "negate", userControlled: true })
  negate?: boolean = false;

  @required()
  @output({ handle: "result" })
  result!: unknown[];
}
