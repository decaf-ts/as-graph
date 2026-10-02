/**
 * @module as-graph/nodes/flow/loop/until
 * @summary Until loop node declaration.
 * @description Shared declaration for the `core.loop.until` system node kind
 * (decorator id `graph-until-loop-node`), ported from the for-angular demo
 * app so the loop kinds become shared canvas nodes. The class's own
 * `execute` is the only implementation of the kind, derived by
 * `GraphBuiltInRegistrations`, and reaches engine services through
 * `GraphExecutionContext.engine`. The loop-body workflow is demo/app-side
 * content and is not part of the shared declaration — the shared class
 * carries the port/metadata shape only.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
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
import { GRAPH_DEFAULT_MAX_LOOP_ITERATIONS } from "../../../../engine/constants";
import { GraphConditionEvaluator } from "../../../../engine/loops/GraphConditionEvaluator";

/** Inputs accepted by the until loop node. */
export type GraphUntilLoopInput = Record<string, unknown>;

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
    title: "graph.node.loop.until.name",
    description:
      "graph.node.loop.until.description",
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
export class GraphUntilLoopNode extends GraphNode<
  GraphUntilLoopInput,
  GraphExecutionValues
> {
  /**
   * Runs the body workflow at least once and repeats until `condition`
   * evaluates truthy against the carried state, emitting `LOOP_*` events per
   * iteration and executing the body as a child run through
   * `engine.execute(bodyWorkflow, ...)`.
   *
   * @param {GraphNodeExecutionRequest<GraphUntilLoopInput>} request - Execution request carrying the `state` input.
   * @param {GraphExecutionContext} context - Execution context providing run metadata and engine access.
   * @return {Promise<GraphExecutionValues>} The final `state` and the executed `iterations` count.
   * @throws {GraphInputError} When no condition is configured.
   * @throws {GraphLoopLimitError} When the loop exceeds the configured maximum iterations.
   * @throws {GraphExecutionError} When the context exposes no engine to execute the body workflow.
   */
  override async execute(
    request: GraphNodeExecutionRequest<GraphUntilLoopInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const metadata = extractLoopMetadata(this, context, "until");
    const input = request.inputs;
    const maxIterations = resolveLoopMaxIterations(
      metadata.maxIterations,
      context.limits?.maxLoopIterations,
      GRAPH_DEFAULT_MAX_LOOP_ITERATIONS,
      "until"
    );
    const condition = metadata.condition;
    if (!condition) {
      throw new GraphInputError("until node is missing a condition");
    }
    const statePort = metadata.statePort ?? "state";
    const bodyInputPort = metadata.inputPort ?? statePort;
    const bodyOutputPort = metadata.outputPort ?? statePort;
    const bodyWorkflow = metadata.body;

    const engine = context.engine;
    if (!engine) {
      throw new GraphExecutionError(
        "until node requires engine access",
        "GRAPH_ENGINE_NOT_AVAILABLE"
      );
    }

    let state = input["state"];
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
        { [bodyInputPort]: state, iteration },
        {
          parentRunId: context.runId,
          path: [...context.path, `iteration:${iteration}`],
          auth: context.auth,
        },
        context
      );

      state = childResult.outputs[bodyOutputPort];

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

    return { state, iterations: iteration };
  }

  /** Initial state threaded into the body workflow's input port each iteration. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.until.fields.state.label",
    placeholder: "graph.node.loop.until.fields.state.placeholder",
    type: "textarea",
  })
  @input({ handle: "state" })
  state!: unknown;

  /** Output carrying the final state after the loop terminates. */
  @required()
  @output({ handle: "state" })
  stateOut!: unknown;

  /** Upper bound on iterations; falls back to the engine default when unset. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.until.fields.maxIterations.label",
    type: "number",
  })
  @input({ handle: "maxIterations", userControlled: true })
  maxIterations?: number;

  /** Condition evaluated against the state after each iteration. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.until.fields.condition.label",
    type: "code",
  })
  @input({ handle: "condition", userControlled: true })
  condition?: GraphLoopMetadata["condition"];

  /** Overrides the handle used to thread loop state across iterations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.until.fields.statePort.label",
    type: "text",
  })
  @input({ handle: "statePort", userControlled: true })
  statePort?: string;

  /** Overrides the body workflow's input handle receiving the state. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.until.fields.inputPort.label",
    type: "text",
  })
  @input({ handle: "inputPort", userControlled: true })
  inputPort?: string;

  /** Overrides the body workflow's output handle returning the updated state. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.until.fields.outputPort.label",
    type: "text",
  })
  @input({ handle: "outputPort", userControlled: true })
  outputPort?: string;
}
