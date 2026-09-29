/**
 * @module as-graph/nodes/loops/foreach
 * @summary Foreach loop node declaration.
 * @description Shared declaration for the `core.loop.foreach` system node
 * kind (decorator id `graph-foreach-loop-node`), ported from the for-angular
 * demo app so the loop kinds become shared canvas nodes. The class's own
 * `static execute` is the only implementation of the kind, derived by
 * `GraphBuiltInRegistrations`, and reaches engine services through
 * `GraphExecutionContext.engine`. The loop-body workflow is demo/app-side
 * content and is not part of the shared declaration — the shared class
 * carries the port/metadata shape only.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, input, node, output } from "../../shared/graph";
import { GraphNode } from "../base";
import type { GraphExecutionContext } from "../../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";
import { GraphExecutionEventType } from "../../shared/graph";
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
import { GraphInputError } from "../../engine/errors/GraphInputError";
import { GraphLoopLimitError } from "../../engine/errors/GraphLoopLimitError";
import { extractLoopMetadata } from "./loop-metadata";
import { GRAPH_DEFAULT_MAX_FOREACH_ITERATIONS } from "../../engine/constants";
import { GraphBreakSignal } from "../../engine/errors/GraphBreakSignal";

/**
 * Foreach loop node (`core.loop.foreach`): iterates a body workflow over a collection.
 */
@node("graph-foreach-loop-node", {
  kind: "core.loop.foreach",
  category: "Loop",
  color: "#eab308",
  icon: "ti-repeat",
  width: 120,
  height: 140,
  labels: ["loop", "iteration", "foreach"],
  metadata: {
    title: "Foreach loop",
    description:
      "Iterates over an array input and executes the body once per item (or per slice of items).",
    loop: {
      maxIterations: 100,
      itemPort: "item",
      resultPort: "result",
      slice: 1,
    },
  },
})
@model()
export class GraphForeachLoopNode extends GraphNode {
  static override async execute(
    request: GraphNodeExecutionRequest,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const metadata = extractLoopMetadata(context, "foreach");
    const input = request.inputs;
    const items = input.items;
    const maxIterations =
      metadata.maxIterations ?? GRAPH_DEFAULT_MAX_FOREACH_ITERATIONS;

    if (!Array.isArray(items)) {
      throw new GraphInputError("foreach input 'items' must be an array");
    }

    const engine = context.engine;
    if (!engine) {
      throw new GraphExecutionError(
        "foreach node requires engine access",
        "GRAPH_ENGINE_NOT_AVAILABLE"
      );
    }

    const sliceRaw = Number(input.slice ?? metadata.slice ?? 1);
    const slice =
      Number.isFinite(sliceRaw) && sliceRaw > 0 ? Math.floor(sliceRaw) : 1;
    const iterations =
      slice > 1 ? Math.ceil(items.length / slice) : items.length;

    if (iterations > maxIterations) {
      throw new GraphLoopLimitError(
        `foreach exceeded max iterations (${iterations} > ${maxIterations})`
      );
    }

    const itemPort = metadata.itemPort ?? "item";
    const resultPort = metadata.resultPort ?? "result";
    const statePort = metadata.statePort ?? "state";
    const bodyWorkflow = metadata.body;

    const results: unknown[] = [];
    let state = input.state;
    let broken = false;

    await context.emit({ type: GraphExecutionEventType.LOOP_STARTED });

    for (let i = 0; i < iterations; i++) {
      await context.emit({
        type: GraphExecutionEventType.LOOP_ITERATION_STARTED,
        iteration: i,
      });

      const sliceItems =
        slice > 1 ? items.slice(i * slice, i * slice + slice) : items[i];
      const childInputs: GraphExecutionValues = {
        [itemPort]: sliceItems,
        index: i,
      };
      if (slice > 1) childInputs["slice"] = sliceItems;
      if (state !== undefined) childInputs[statePort] = state;

      try {
        const childResult = await engine.execute(bodyWorkflow, childInputs, {
          parentRunId: context.runId,
          path: [...context.path, `iteration:${i}`],
          metadata: { item: sliceItems, index: i, slice },
        });

        results.push(childResult.outputs[resultPort]);
        if (childResult.outputs[statePort] !== undefined) {
          state = childResult.outputs[statePort];
        }
      } catch (err) {
        if (err instanceof GraphBreakSignal) {
          const carried = (err.details as { value?: unknown } | undefined)
            ?.value;
          if (carried !== undefined) results.push(carried);
          broken = true;
          await context.emit({
            type: GraphExecutionEventType.LOOP_ITERATION_COMPLETED,
            iteration: i,
            metadata: { broken: true },
          });
          break;
        }
        throw err;
      }

      await context.emit({
        type: GraphExecutionEventType.LOOP_ITERATION_COMPLETED,
        iteration: i,
      });
    }

    await context.emit({
      type: GraphExecutionEventType.LOOP_COMPLETED,
      metadata: { broken },
    });

    const output: GraphExecutionValues = {
      results,
      completed: results,
      iterations: results.length,
      broken,
    };
    if (state !== undefined) output[statePort] = state;
    return output;
  }

  @required()
  @uielement("textarea", {
    label: "Items",
    placeholder: "Array to iterate over",
  })
  @input({ handle: "items" })
  items!: unknown[];

  @required()
  @uielement("input", {
    label: "Slice size",
    placeholder: "Items per iteration (default 1)",
  })
  @input({ handle: "slice" })
  slice!: number;

  @required()
  @output({ handle: "item" })
  item!: unknown;

  @required()
  @connection({
    handle: "loop",
    connectionRules: { allowSelf: true, maxConnections: 1 },
  })
  loop!: unknown;

  @required()
  @output({ handle: "completed" })
  completed!: unknown[];
}
