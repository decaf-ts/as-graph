/**
 * @module as-graph/tests/unit/graph/nodes/GraphUntilLoopNode.test
 * @summary Dedicated unit tests for the `core.loop.until` node class's instance
 * `execute` (DECAF-50 §4.26 R2-1, §4.4.5, SAA-2015).
 */
import { GraphUntilLoopNode } from "../../../../src/node";
import { GraphInputError } from "../../../../src/engine/errors/GraphInputError";
import { GraphLoopLimitError } from "../../../../src/engine/errors/GraphLoopLimitError";
import type { CodeSandboxEvaluator } from "../../../../src/engine/execution/CodeSandboxEvaluator";
import {
  GraphExecutionEventType,
  graphNodeManifest,
} from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import {
  buildNodeContext,
  codeSandboxEngine,
  loopEngine,
} from "./node-test-utils";

/** Body workflow whose `state` output increments the routed `n`. */
function incrementEngine() {
  return loopEngine((inputs) => {
    const state = inputs["state"] as { n: number };
    return { state: { n: state.n + 1 } };
  });
}

describe("GraphUntilLoopNode", () => {
  const manifest = graphNodeManifest(GraphUntilLoopNode);

  describe("manifest", () => {
    it("publishes the core.loop.until kind with the loop capability", () => {
      expect(manifest.kind).toBe("core.loop.until");
    });

    it("declares the state input and the state output", () => {
      expect(manifest.inputs.map((port) => port.id)).toContain("state");
      expect(manifest.outputs.map((port) => port.id)).toEqual(["state"]);
    });

    it("declares the user-controllable condition/maxIterations/statePort parameters", () => {
      const ids = manifest.parameters.map((parameter) => parameter.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          "maxIterations",
          "condition",
          "statePort",
          "inputPort",
          "outputPort",
        ])
      );
    });
  });

  describe("execute", () => {
    it("runs the body until the condition becomes true and returns the final state", async () => {
      const context = buildNodeContext("core.loop.until", {
        parameters: {
          condition: { type: "greaterThanOrEqual", left: "n", right: 2 },
        },
        loop: { body: {} as never },
        engine: incrementEngine(),
      });
      const result = await executeNode(
        GraphUntilLoopNode,
        nodeExecutionRequest({ state: { n: 0 } }),
        context
      );
      expect(result).toEqual({ state: { n: 2 }, iterations: 2 });
    });

    it("always runs the body at least once even when the condition already holds", async () => {
      const context = buildNodeContext("core.loop.until", {
        parameters: {
          condition: { type: "greaterThanOrEqual", left: "n", right: 2 },
        },
        loop: { body: {} as never },
        engine: incrementEngine(),
      });
      const result = await executeNode(
        GraphUntilLoopNode,
        nodeExecutionRequest({ state: { n: 5 } }),
        context
      );
      expect(result).toEqual({ state: { n: 6 }, iterations: 1 });
    });

    it("seeds the body on the user-controllable statePort and returns the final state on `state`", async () => {
      const bodyInputs: Record<string, unknown>[] = [];
      const context = buildNodeContext("core.loop.until", {
        parameters: {
          statePort: "acc",
          condition: { type: "greaterThanOrEqual", left: "n", right: 1 },
        },
        loop: { body: {} as never },
        engine: loopEngine((inputs) => {
          bodyInputs.push(inputs);
          return { acc: { n: (inputs["acc"] as { n: number }).n + 1 } };
        }),
      });
      const result = await executeNode(
        GraphUntilLoopNode,
        nodeExecutionRequest({ state: { n: 0 } }),
        context
      );
      expect(bodyInputs).toEqual([{ acc: { n: 0 }, iteration: 0 }]);
      expect(result).toEqual({ state: { n: 1 }, iterations: 1 });
    });

    it("emits LOOP_STARTED and LOOP_COMPLETED around the iterations", async () => {
      const events: unknown[] = [];
      const context = buildNodeContext("core.loop.until", {
        parameters: {
          condition: { type: "greaterThanOrEqual", left: "n", right: 1 },
        },
        loop: { body: {} as never },
        engine: incrementEngine(),
        emit: async (event) => {
          events.push(event.type);
        },
      });
      await executeNode(
        GraphUntilLoopNode,
        nodeExecutionRequest({ state: { n: 0 } }),
        context
      );
      expect(events[0]).toBe(GraphExecutionEventType.LOOP_STARTED);
      expect(events.at(-1)).toBe(GraphExecutionEventType.LOOP_COMPLETED);
    });

    it("throws GraphInputError when the condition is missing", async () => {
      const context = buildNodeContext("core.loop.until", {
        loop: { body: {} as never },
        engine: incrementEngine(),
      });
      await expect(
        executeNode(
          GraphUntilLoopNode,
          nodeExecutionRequest({ state: { n: 0 } }),
          context
        )
      ).rejects.toThrow(GraphInputError);
      await expect(
        executeNode(
          GraphUntilLoopNode,
          nodeExecutionRequest({ state: { n: 0 } }),
          context
        )
      ).rejects.toThrow(/missing a condition/i);
    });

    it("throws GraphExecutionError GRAPH_ENGINE_NOT_AVAILABLE without an engine", async () => {
      const context = buildNodeContext("core.loop.until", {
        parameters: {
          condition: { type: "greaterThanOrEqual", left: "n", right: 1 },
        },
        loop: { body: {} as never },
      });
      await expect(
        executeNode(
          GraphUntilLoopNode,
          nodeExecutionRequest({ state: { n: 0 } }),
          context
        )
      ).rejects.toThrow(/requires engine access/i);
    });

    it("throws GraphInputError when the loop body is missing", async () => {
      const context = buildNodeContext("core.loop.until", {
        parameters: {
          condition: { type: "greaterThanOrEqual", left: "n", right: 1 },
        },
        engine: incrementEngine(),
      });
      await expect(
        executeNode(
          GraphUntilLoopNode,
          nodeExecutionRequest({ state: { n: 0 } }),
          context
        )
      ).rejects.toThrow(/missing loop configuration/i);
    });

    it("throws GraphLoopLimitError when the condition never becomes true", async () => {
      const context = buildNodeContext("core.loop.until", {
        parameters: {
          maxIterations: 2,
          condition: { type: "falsy", left: "n" },
        },
        loop: { body: {} as never },
        engine: loopEngine((inputs) => ({ state: inputs["state"] })),
      });
      let error: unknown;
      try {
        await executeNode(
          GraphUntilLoopNode,
          nodeExecutionRequest({ state: { n: 1 } }),
          context
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GraphLoopLimitError);
      expect((error as GraphLoopLimitError).graphCode).toBe(
        "GRAPH_LOOP_LIMIT_ERROR"
      );
    });
  });

  describe("CodeCondition (code mode, SAA-66)", () => {
    /** Increments `state.n` and returns it under `state`. */
    function incrementState(
      inputs: Record<string, unknown>
    ): Record<string, unknown> {
      const state = inputs["state"] as { n: number };
      return { state: { n: state.n + 1 } };
    }

    it("evaluates the code condition after each iteration and stops when it flips", async () => {
      const seen: unknown[] = [];
      const evaluator: CodeSandboxEvaluator = {
        evaluate: (ctx) => {
          const state = (ctx.input as { state: { n: number } }).state;
          seen.push(state.n);
          return state.n >= 2;
        },
      };
      const context = buildNodeContext("core.loop.until", {
        parameters: {
          condition: { type: "code", code: "return $input.state.n >= 2;" },
        },
        loop: { body: {} as never },
        engine: codeSandboxEngine(evaluator, incrementState),
      });
      const result = await executeNode(
        GraphUntilLoopNode,
        nodeExecutionRequest({ state: { n: 0 } }),
        context
      );
      expect(result).toEqual({ state: { n: 2 }, iterations: 2 });
      expect(seen).toEqual([1, 2]);
    });

    it("exposes the current state plus the other inputs to the sandbox as $input", async () => {
      const seenInputs: Record<string, unknown>[] = [];
      const evaluator: CodeSandboxEvaluator = {
        evaluate: (ctx) => {
          seenInputs.push(ctx.input as Record<string, unknown>);
          return (ctx.input as { state: { n: number } }).state.n >= 1;
        },
      };
      const context = buildNodeContext("core.loop.until", {
        parameters: {
          condition: { type: "code", code: "return true;" },
        },
        loop: { body: {} as never },
        engine: codeSandboxEngine(evaluator, incrementState),
      });
      await executeNode(
        GraphUntilLoopNode,
        nodeExecutionRequest({ state: { n: 0 }, extra: "keep" }),
        context
      );
      expect(seenInputs).toEqual([{ state: { n: 1 }, extra: "keep" }]);
    });

    it("throws GRAPH_CODE_SANDBOX_NOT_CONFIGURED without a registered evaluator", async () => {
      const context = buildNodeContext("core.loop.until", {
        parameters: {
          condition: { type: "code", code: "return true;" },
        },
        loop: { body: {} as never },
        engine: incrementEngine(),
      });
      await expect(
        executeNode(
          GraphUntilLoopNode,
          nodeExecutionRequest({ state: { n: 0 } }),
          context
        )
      ).rejects.toMatchObject({
        graphCode: "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
      });
    });
  });
});
