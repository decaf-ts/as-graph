/**
 * @module as-graph/nodes/flow/loop/foreach
 * @summary Foreach loop node declaration.
 * @description Shared declaration for the `core.loop.foreach` system node
 * kind (decorator id `graph-foreach-loop-node`), ported from the for-angular
 * demo app so the loop kinds become shared canvas nodes. The class's own
 * `execute` is the only implementation of the kind, derived by
 * `GraphBuiltInRegistrations`, and reaches engine services through
 * `GraphExecutionContext.engine`. The loop-body workflow is demo/app-side
 * content and is not part of the shared declaration — the shared class
 * carries the port/metadata shape only.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import type { GraphExecutionContext } from "../../../../engine/execution/GraphExecutionContext";
import type {
  GraphExecutionValues,
  GraphLoopMetadata,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";
import { GraphExecutionEventType } from "../../../../shared/graph";
import { GraphExecutionError } from "../../../../engine/errors/GraphExecutionError";
import { GraphInputError } from "../../../../engine/errors/GraphInputError";
import { GraphLoopLimitError } from "../../../../engine/errors/GraphLoopLimitError";
import { extractLoopMetadata, resolveLoopMaxIterations } from "../loop-metadata";
import { GRAPH_DEFAULT_MAX_FOREACH_ITERATIONS } from "../../../../engine/constants";
import { GraphBreakSignal } from "../../../../engine/errors/GraphBreakSignal";

/** Inputs accepted by the foreach loop node. */
export type GraphForeachLoopInput = Record<string, unknown>;

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
    title: "graph.node.loop.foreach.name",
    description:
      "graph.node.loop.foreach.description",
    loop: {
      maxIterations: 100,
      itemPort: "item",
      resultPort: "result",
      slice: 1,
    },
  },
})
@model()
export class GraphForeachLoopNode extends GraphNode<
  GraphForeachLoopInput,
  GraphExecutionValues
> {
  /**
   * Iterates the body workflow over the `items` input, emitting
   * `LOOP_*` events per iteration and routing each slice through
   * `engine.execute(bodyWorkflow, ...)` as a child run.
   *
   * @param {GraphNodeExecutionRequest<GraphForeachLoopInput>} request - Execution request carrying the `items`/`slice`/`state` inputs.
   * @param {GraphExecutionContext} context - Execution context providing run metadata and engine access.
   * @return {Promise<GraphExecutionValues>} Collected per-iteration results plus `iterations`/`broken` counters.
   * @throws {GraphInputError} When `items` is not an array or the kind is misconfigured.
   * @throws {GraphLoopLimitError} When the projected iteration count exceeds the configured maximum.
   * @throws {GraphExecutionError} When the context exposes no engine to execute the body workflow.
   */
  override async execute(
    request: GraphNodeExecutionRequest<GraphForeachLoopInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const metadata = extractLoopMetadata(this, context, "foreach");
    const input = request.inputs;
    const items = input["items"];
    const maxIterations = resolveLoopMaxIterations(
      metadata.maxIterations,
      context.limits?.maxForeachIterations,
      GRAPH_DEFAULT_MAX_FOREACH_ITERATIONS,
      "foreach"
    );

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

    const sliceRaw = Number(input["slice"] ?? metadata.slice ?? 1);
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
    let state = input["state"];
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
        const childResult = await engine.execute(
          bodyWorkflow,
          childInputs,
          {
            parentRunId: context.runId,
            path: [...context.path, `iteration:${i}`],
            metadata: { item: sliceItems, index: i, slice },
            auth: context.auth,
          },
          context
        );

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

  /** Collection to iterate; each entry (or slice of entries) feeds the body workflow. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.foreach.fields.items.label",
    placeholder: "graph.node.loop.foreach.fields.items.placeholder",
    type: "textarea",
  })
  @input({ handle: "items" })
  items!: unknown[];

  /** Number of collection entries processed per iteration; defaults to 1. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.foreach.fields.slice.label",
    placeholder: "graph.node.loop.foreach.fields.slice.placeholder",
    type: "number",
  })
  @input({ handle: "slice" })
  slice!: number;

  /** Per-iteration output carrying the current entry (or slice) to the body workflow. */
  @required()
  @output({ handle: "item" })
  item!: unknown;

  /** Connection handle binding the body workflow executed once per iteration. */
  @required()
  @connection({
    handle: "loop",
    connectionRules: { allowSelf: true, maxConnections: 1 },
  })
  loop!: unknown;

  /** Output collecting the body workflow's per-iteration `result` values. */
  @required()
  @output({ handle: "completed" })
  completed!: unknown[];

  /** Upper bound on iterations; falls back to the engine default when unset. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.foreach.fields.maxIterations.label",
    type: "number",
  })
  @input({ handle: "maxIterations", userControlled: true })
  maxIterations?: number;

  /** Optional loop-exit condition evaluated against the accumulated state. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.foreach.fields.condition.label",
    type: "code",
  })
  @input({ handle: "condition", userControlled: true })
  condition?: GraphLoopMetadata["condition"];

  /** Overrides the output handle name the current entry is routed under. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.foreach.fields.itemPort.label",
    type: "text",
  })
  @input({ handle: "itemPort", userControlled: true })
  itemPort?: string;

  /** Overrides the output handle whose value is collected into `results`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.foreach.fields.resultPort.label",
    type: "text",
  })
  @input({ handle: "resultPort", userControlled: true })
  resultPort?: string;

  /** Overrides the handle used to thread loop state across iterations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.foreach.fields.statePort.label",
    type: "text",
  })
  @input({ handle: "statePort", userControlled: true })
  statePort?: string;
}
