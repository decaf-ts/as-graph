/**
 * @module as-graph/nodes/flow/loop/while
 * @summary While loop node declaration.
 * @description Shared declaration for the `core.loop.while` system node kind
 * (decorator id `graph-while-loop-node`), ported from the for-angular demo
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

/** Inputs accepted by the while loop node. */
export type GraphWhileLoopInput = Record<string, unknown>;

/**
 * While loop node (`core.loop.while`): repeats a body workflow while a condition holds.
 */
@node("graph-while-loop-node", {
  kind: "core.loop.while",
  category: "Loop",
  color: "#eab308",
  icon: "ti-arrows-loop",
  width: 96,
  height: 96,
  labels: ["loop", "conditional", "while"],
  metadata: {
    title: "graph.node.loop.while.name",
    description:
      "graph.node.loop.while.description",
    loop: {
      maxIterations: 50,
      statePort: "state",
      condition: {
        type: "lessThan" as never,
        left: "iteration",
        right: 3,
      },
    },
  },
})
@model()
export class GraphWhileLoopNode extends GraphNode<
  GraphWhileLoopInput,
  GraphExecutionValues
> {
  /**
   * Repeats the body workflow while `condition` evaluates truthy against the
   * carried state, emitting `LOOP_*` events per iteration and executing the
   * body as a child run through `engine.execute(bodyWorkflow, ...)`. A
   * `CodeCondition` is dispatched through the registered
   * `CodeSandboxEvaluator`; a graphical `ConditionExpression` and the built-in
   * comparison types are evaluated directly.
   *
   * @param {GraphNodeExecutionRequest<GraphWhileLoopInput>} request - Execution request carrying the `state` input.
   * @param {GraphExecutionContext} context - Execution context providing run metadata and engine access.
   * @return {Promise<GraphExecutionValues>} The final `state` and the executed `iterations` count.
   * @throws {GraphInputError} When no condition is configured.
   * @throws {GraphLoopLimitError} When the loop exceeds the configured maximum iterations.
   * @throws {GraphExecutionError} When the context exposes no engine to execute the body workflow.
   */
  override async execute(
    request: GraphNodeExecutionRequest<GraphWhileLoopInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const metadata = extractLoopMetadata(this, context, "while");
    const input = request.inputs;
    const maxIterations = resolveLoopMaxIterations(
      metadata.maxIterations,
      context.limits?.maxLoopIterations,
      GRAPH_DEFAULT_MAX_LOOP_ITERATIONS,
      "while"
    );
    const condition = metadata.condition;
    if (!condition) {
      throw new GraphInputError("while node is missing a condition");
    }
    const statePort = metadata.statePort ?? "state";
    const bodyInputPort = metadata.inputPort ?? statePort;
    const bodyOutputPort = metadata.outputPort ?? statePort;
    const bodyWorkflow = metadata.body;

    const engine = context.engine;
    if (!engine) {
      throw new GraphExecutionError(
        "while node requires engine access",
        "GRAPH_ENGINE_NOT_AVAILABLE"
      );
    }

    let state = input["state"];
    let iteration = 0;

    await context.emit({ type: GraphExecutionEventType.LOOP_STARTED });

    while (
      await new GraphConditionEvaluator().evaluateAsync(condition, state, context, {
        ...input,
        state,
      })
    ) {
      if (iteration >= maxIterations) {
        await context.emit({
          type: GraphExecutionEventType.LOOP_LIMIT_REACHED,
          iteration,
        });
        throw new GraphLoopLimitError(
          `while loop exceeded max iterations (${maxIterations})`
        );
      }

      await context.emit({
        type: GraphExecutionEventType.LOOP_CONDITION_EVALUATED,
        iteration,
        payload: { result: true },
      });
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

      iteration++;
    }

    await context.emit({ type: GraphExecutionEventType.LOOP_COMPLETED });

    return { state, iterations: iteration };
  }

  /** Initial state threaded into the body workflow's input port each iteration. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.while.fields.state.label",
    placeholder: "graph.node.loop.while.fields.state.placeholder",
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
    label: "graph.node.loop.while.fields.maxIterations.label",
    type: "number",
  })
  @input({ handle: "maxIterations", userControlled: true })
  maxIterations?: number;

  /** Condition evaluated against the state before each iteration. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.while.fields.condition.label",
    type: "code",
  })
  @input({ handle: "condition", userControlled: true })
  condition?: GraphLoopMetadata["condition"];

  /** Overrides the handle used to thread loop state across iterations. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.while.fields.statePort.label",
    type: "text",
  })
  @input({ handle: "statePort", userControlled: true })
  statePort?: string;

  /** Overrides the body workflow's input handle receiving the state. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.while.fields.inputPort.label",
    type: "text",
  })
  @input({ handle: "inputPort", userControlled: true })
  inputPort?: string;

  /** Overrides the body workflow's output handle returning the updated state. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.loop.while.fields.outputPort.label",
    type: "text",
  })
  @input({ handle: "outputPort", userControlled: true })
  outputPort?: string;
}
