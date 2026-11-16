/**
 * @module as-graph/nodes/utility/map
 * @summary Map utility node declaration (DECAF-32 §22.2.2).
 * @description Map — evaluates one expression per input item and emits the
 * mapped items. It is the per-item counterpart of the Code node: the Code node
 * runs once over the whole input, the Map node runs once per item.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import type { CodeSandboxEvaluator } from "../../../engine/execution/CodeSandboxEvaluator";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";

/** Inputs accepted by the map node. */
export type MapNodeInput = Record<string, unknown>;

/** Outputs produced by the map node. */
export interface MapNodeOutput {
  /** The mapped items (a list in, a list out; a single value in, one out). */
  result: unknown;
  /** How many items were mapped. */
  count?: number;
}

/**
 * Wraps a bare expression so the sandbox returns its value.
 *
 * The field accepts either an expression (`$item.price * $item.qty`) or a
 * statement body that returns by itself (`const t = …; return t;`). A body
 * that already contains a `return` is passed through unchanged.
 *
 * @param expression - The configured expression or statement body.
 * @returns Sandbox-ready code that returns the mapped value.
 */
export function graphMapCodeOf(expression: string): string {
  return /(^|[\s;{}])return[\s;(]/.test(expression)
    ? expression
    : `return (${expression.trim().replace(/;+\s*$/, "").trim()});`;
}

/**
 * Map utility node: evaluates `expression` once per input item.
 *
 * Inside the expression `$item` is the current item, `$index` its position and
 * `$input` the node's whole input record. A list input yields a list of the
 * same length; any other input is mapped as a single item and yields a single
 * value.
 */
@node("core.utility.map", {
  kind: "core.utility.map",
  category: "Utility",
  color: "#0d9488",
  icon: "ti-arrows-right-left",
  width: 96,
  height: 96,
  labels: ["utility", "map", "transform"],
  metadata: {
    title: "graph.node.utility.map.name",
    description: "graph.node.utility.map.description",
  },
})
@model()
export class MapNode extends GraphNode<MapNodeInput, MapNodeOutput> {
  /**
   * Maps every input item through the configured expression.
   *
   * @param {GraphNodeExecutionRequest<MapNodeInput>} request - Execution request carrying the `value` input.
   * @param {GraphExecutionContext} context - Run-scoped context supplying the code sandbox.
   * @return {Promise<GraphExecutionValues>} The mapped items under `result` and their number under `count`.
   * @throws {GraphExecutionError} `GRAPH_MAP_EXPRESSION_REQUIRED` when no expression is configured.
   * @throws {GraphExecutionError} `GRAPH_CODE_SANDBOX_NOT_CONFIGURED` when the engine has no code sandbox.
   */
  override async execute(
    request: GraphNodeExecutionRequest<MapNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const expression =
      typeof this.expression === "string" ? this.expression.trim() : "";
    if (expression.length === 0) {
      throw new GraphExecutionError(
        "Map node requires an expression to evaluate for each item",
        "GRAPH_MAP_EXPRESSION_REQUIRED",
        { nodeId: request.nodeId }
      );
    }
    const evaluator = (
      context?.engine as
        | { codeSandboxEvaluator?: CodeSandboxEvaluator }
        | undefined
    )?.codeSandboxEvaluator;
    if (!evaluator) {
      throw new GraphExecutionError(
        "Map node execution requires a CodeSandboxEvaluator to be registered in GraphExecutionEngineConfig.codeSandboxEvaluator",
        "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
        { nodeId: request.nodeId }
      );
    }

    const value = request.inputs["value"];
    const isList = Array.isArray(value);
    const items: unknown[] = isList ? (value as unknown[]) : [value];
    const code = graphMapCodeOf(expression);
    const md = context.metadata as Record<string, unknown> | undefined;
    const mapped: unknown[] = [];
    for (let index = 0; index < items.length; index++) {
      mapped.push(
        await evaluator.evaluate({
          code,
          language: "javascript",
          input: request.inputs as Record<string, unknown>,
          vars: (md?.vars as Record<string, unknown> | undefined) ?? undefined,
          item: items[index],
          index,
          abortSignal: context.abortSignal,
        })
      );
    }
    return { result: isList ? mapped : mapped[0], count: mapped.length };
  }

  /** The item list (or single value) to map. */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /**
   * Expression evaluated once per item; `$item`, `$index` and `$input` are in
   * scope. A bare expression is returned as-is; a statement body must `return`.
   */
  @required()
  @uielement("code-editor", {
    label: "graph.node.utility.map.fields.expression.label",
    placeholder: "graph.node.utility.map.fields.expression.placeholder",
  })
  @input({ handle: "expression", userControlled: true, type: "string" })
  expression!: string;

  /** Output carrying the mapped items. */
  @required()
  @output({ handle: "result" })
  result!: unknown;

  /** Output carrying how many items were mapped. */
  @output({ handle: "count", type: "number" })
  count?: number;
}
