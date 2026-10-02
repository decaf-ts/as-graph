/**
 * @module as-graph/tests/unit/graph/nodes/GraphWhileLoopNode.test
 * @summary Dedicated unit tests for the `core.loop.while` node class's instance
 * `execute` (DECAF-50 §4.26 R2-1, §4.4.5, SAA-2015).
 */
import { GraphWhileLoopNode } from "../../../../src/node";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import { GraphInputError } from "../../../../src/engine/errors/GraphInputError";
import { GraphLoopLimitError } from "../../../../src/engine/errors/GraphLoopLimitError";
import {
  GraphExecutionEventType,
  graphNodeManifest,
} from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext, loopEngine } from "./node-test-utils";

/** Body workflow whose `state` output increments the routed `n`. */
function incrementEngine() {
  return loopEngine((inputs) => {
    const state = inputs["state"] as { n: number };
    return { state: { n: state.n + 1 } };
  });
}

describe("GraphWhileLoopNode", () => {
  const manifest = graphNodeManifest(GraphWhileLoopNode);

  describe("manifest", () => {
    it("publishes the core.loop.while kind with the loop capability", () => {
      expect(manifest.kind).toBe("core.loop.while");
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
    it("repeats the body while the condition holds and returns the final state", async () => {
      const context = buildNodeContext("core.loop.while", {
        parameters: {
          condition: { type: "lessThan", left: "n", right: 2 },
        },
        loop: { body: {} as never },
        engine: incrementEngine(),
      });
      const result = await executeNode(
        GraphWhileLoopNode,
        nodeExecutionRequest({ state: { n: 0 } }),
        context
      );
      expect(result).toEqual({ state: { n: 2 }, iterations: 2 });
    });

    it("performs zero iterations when the condition is initially false", async () => {
      const context = buildNodeContext("core.loop.while", {
        parameters: {
          condition: { type: "lessThan", left: "n", right: 2 },
        },
        loop: { body: {} as never },
        engine: incrementEngine(),
      });
      const result = await executeNode(
        GraphWhileLoopNode,
        nodeExecutionRequest({ state: { n: 5 } }),
        context
      );
      expect(result).toEqual({ state: { n: 5 }, iterations: 0 });
    });

    it("seeds the body on the user-controllable statePort and returns the final state on `state`", async () => {
      const bodyInputs: Record<string, unknown>[] = [];
      const context = buildNodeContext("core.loop.while", {
        parameters: {
          statePort: "acc",
          condition: { type: "lessThan", left: "n", right: 1 },
        },
        loop: { body: {} as never },
        engine: loopEngine((inputs) => {
          bodyInputs.push(inputs);
          return { acc: { n: (inputs["acc"] as { n: number }).n + 1 } };
        }),
      });
      const result = await executeNode(
        GraphWhileLoopNode,
        nodeExecutionRequest({ state: { n: 0 } }),
        context
      );
      expect(bodyInputs).toEqual([{ acc: { n: 0 }, iteration: 0 }]);
      expect(result).toEqual({ state: { n: 1 }, iterations: 1 });
    });

    it("emits LOOP_STARTED and LOOP_COMPLETED around the iterations", async () => {
      const events: unknown[] = [];
      const context = buildNodeContext("core.loop.while", {
        parameters: {
          condition: { type: "lessThan", left: "n", right: 1 },
        },
        loop: { body: {} as never },
        engine: incrementEngine(),
        emit: async (event) => {
          events.push(event.type);
        },
      });
      await executeNode(
        GraphWhileLoopNode,
        nodeExecutionRequest({ state: { n: 0 } }),
        context
      );
      expect(events[0]).toBe(GraphExecutionEventType.LOOP_STARTED);
      expect(events.at(-1)).toBe(GraphExecutionEventType.LOOP_COMPLETED);
    });

    it("throws GraphInputError when the condition is missing", async () => {
      const context = buildNodeContext("core.loop.while", {
        loop: { body: {} as never },
        engine: incrementEngine(),
      });
      await expect(
        executeNode(
          GraphWhileLoopNode,
          nodeExecutionRequest({ state: { n: 0 } }),
          context
        )
      ).rejects.toThrow(GraphInputError);
      await expect(
        executeNode(
          GraphWhileLoopNode,
          nodeExecutionRequest({ state: { n: 0 } }),
          context
        )
      ).rejects.toThrow(/missing a condition/i);
    });

    it("throws GraphExecutionError GRAPH_ENGINE_NOT_AVAILABLE without an engine", async () => {
      const context = buildNodeContext("core.loop.while", {
        parameters: {
          condition: { type: "lessThan", left: "n", right: 1 },
        },
        loop: { body: {} as never },
      });
      await expect(
        executeNode(
          GraphWhileLoopNode,
          nodeExecutionRequest({ state: { n: 0 } }),
          context
        )
      ).rejects.toThrow(/requires engine access/i);
    });

    it("throws GraphInputError when the loop body is missing", async () => {
      const context = buildNodeContext("core.loop.while", {
        parameters: {
          condition: { type: "lessThan", left: "n", right: 1 },
        },
        engine: incrementEngine(),
      });
      await expect(
        executeNode(
          GraphWhileLoopNode,
          nodeExecutionRequest({ state: { n: 0 } }),
          context
        )
      ).rejects.toThrow(/missing loop configuration/i);
    });

    it("throws GraphLoopLimitError when the condition never becomes false", async () => {
      const context = buildNodeContext("core.loop.while", {
        parameters: {
          maxIterations: 2,
          condition: { type: "truthy", left: "n" },
        },
        loop: { body: {} as never },
        engine: loopEngine((inputs) => ({ state: inputs["state"] })),
      });
      let error: unknown;
      try {
        await executeNode(
          GraphWhileLoopNode,
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

    it("propagates a body execution failure", async () => {
      const failure = new GraphExecutionError("body failed", "GRAPH_BODY_FAIL");
      const context = buildNodeContext("core.loop.while", {
        parameters: {
          condition: { type: "lessThan", left: "n", right: 1 },
        },
        loop: { body: {} as never },
        engine: {
          execute: async () => {
            throw failure;
          },
        } as never,
      });
      await expect(
        executeNode(
          GraphWhileLoopNode,
          nodeExecutionRequest({ state: { n: 0 } }),
          context
        )
      ).rejects.toBe(failure);
    });
  });
});
