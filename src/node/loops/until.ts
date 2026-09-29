/**
 * @module as-graph/nodes/loops/until
 * @summary Until loop node declaration.
 * @description Shared declaration for the `core.loop.until` system node kind
 * (decorator id `graph-until-loop-node`), ported from the for-angular demo
 * app so the loop kinds become shared canvas nodes. The class's own
 * `static execute` is the only implementation of the kind, derived by
 * `GraphBuiltInRegistrations`, and reaches engine services through
 * `GraphExecutionContext.engine`. The loop-body workflow is demo/app-side
 * content and is not part of the shared declaration — the shared class
 * carries the port/metadata shape only.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../shared/graph";
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
import { GRAPH_DEFAULT_MAX_LOOP_ITERATIONS } from "../../engine/constants";
import { GraphConditionEvaluator } from "../../engine/loops/GraphConditionEvaluator";

/**
 * Until loop node (`core.loop.until`): repeats a body workflow until a condition holds.
 */
@node("graph-until-loop-node", {
  kind: "core.loop.until",
  category: "Loop",
  color: "#eab308",
  icon: "ti-player-stop",
  width: 96,
  height: 96,
  labels: ["loop", "conditional", "until"],
  metadata: {
    title: "Until loop",
    description:
      "Repeats the body until the condition is true (post-condition, runs at least once).",
    loop: {
      maxIterations: 50,
      statePort: "state",
      condition: {
        type: "greaterThanOrEqual" as never,
        left: "iteration",
        right: 2,
      },
    },
  },
})
@model()
export class GraphUntilLoopNode extends GraphNode {
  static override async execute(
    request: GraphNodeExecutionRequest,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const metadata = extractLoopMetadata(context, "until");
    const input = request.inputs;
    const maxIterations =
      metadata.maxIterations ?? GRAPH_DEFAULT_MAX_LOOP_ITERATIONS;
    const condition = metadata.condition;
    if (!condition) {
      throw new GraphInputError("until node is missing a condition");
    }
    const statePort = metadata.statePort ?? "state";
    const bodyWorkflow = metadata.body;

    const engine = context.engine;
    if (!engine) {
      throw new GraphExecutionError(
        "until node requires engine access",
        "GRAPH_ENGINE_NOT_AVAILABLE"
      );
    }

    let state = input.state;
    let iteration = 0;

    await context.emit({ type: GraphExecutionEventType.LOOP_STARTED });

    let shouldStop = false;

    do {
      if (iteration >= maxIterations) {
        await context.emit({
          type: GraphExecutionEventType.LOOP_LIMIT_REACHED,
          iteration,
        });
        throw new GraphLoopLimitError(
          `until loop exceeded max iterations (${maxIterations})`
        );
      }

      await context.emit({
        type: GraphExecutionEventType.LOOP_ITERATION_STARTED,
        iteration,
      });

      const childResult = await engine.execute(
        bodyWorkflow,
        { [statePort]: state, iteration },
        {
          parentRunId: context.runId,
          path: [...context.path, `iteration:${iteration}`],
        }
      );

      state = childResult.outputs[statePort];

      await context.emit({
        type: GraphExecutionEventType.LOOP_ITERATION_COMPLETED,
        iteration,
      });

      const conditionResult = new GraphConditionEvaluator().evaluate(
        condition,
        state
      );

      await context.emit({
        type: GraphExecutionEventType.LOOP_CONDITION_EVALUATED,
        iteration,
        payload: { result: conditionResult },
      });

      iteration++;
      shouldStop = conditionResult;
    } while (!shouldStop);

    await context.emit({ type: GraphExecutionEventType.LOOP_COMPLETED });

    return { [statePort]: state, iterations: iteration };
  }

  @required()
  @uielement("input", { label: "State", placeholder: "Initial state" })
  @input({ handle: "state" })
  state!: unknown;

  @required()
  @uielement("input", {
    label: "Final state",
    placeholder: "Final state after loop",
  })
  @output({ handle: "state" })
  stateOut!: unknown;
}
