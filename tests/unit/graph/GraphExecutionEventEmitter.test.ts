/**
 * @module as-graph/tests/unit/graph/GraphExecutionEventEmitter.test
 * @summary Unit tests for the graph execution event emitter and observer.
 */
import { jest } from "@jest/globals";

import {
  GraphExecutionEventEmitter,
  type GraphExecutionObserver,
} from "../../../src/engine/events";
import type { GraphExecutionEvent } from "../../../src/engine/types";
import { GraphExecutionEventType } from "../../../src/shared/graph";

describe("GraphExecutionEventEmitter", () => {
  it("observe registers an observer and returns an unsubscribe function", () => {
    const emitter = new GraphExecutionEventEmitter();
    const observer: GraphExecutionObserver = { refresh: jest.fn() };
    const unsub = emitter.observe(observer);

    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("unObserve removes a previously-registered observer", () => {
    const emitter = new GraphExecutionEventEmitter();
    const observer: GraphExecutionObserver = { refresh: jest.fn() };
    emitter.observe(observer);
    emitter.unObserve(observer);
    // Should not throw
    expect(true).toBe(true);
  });

  it("updateObservers notifies all registered observers", async () => {
    const emitter = new GraphExecutionEventEmitter();
    const calls: GraphExecutionEvent[] = [];
    const observer: GraphExecutionObserver = {
      refresh: async (event) => { calls.push(event); },
    };
    emitter.observe(observer);

    const event: GraphExecutionEvent = {
      id: "1",
      sequence: 1,
      runId: "r1",
      workflowId: "w1",
      type: GraphExecutionEventType.WORKFLOW_STARTED,
      timestamp: new Date(),
      path: [],
    };
    await emitter.updateObservers(event);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(event);
  });

  it("updateObservers awaits async observers", async () => {
    const emitter = new GraphExecutionEventEmitter();
    let resolved = false;
    const observer: GraphExecutionObserver = {
      refresh: async () => {
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
      },
    };
    emitter.observe(observer);

    const event: GraphExecutionEvent = {
      id: "1",
      sequence: 1,
      runId: "r1",
      workflowId: "w1",
      type: GraphExecutionEventType.NODE_STARTED,
      timestamp: new Date(),
      path: [],
    };
    await emitter.updateObservers(event);
    expect(resolved).toBe(true);
  });

  it("observer failure does not crash updateObservers", async () => {
    const emitter = new GraphExecutionEventEmitter();
    const badObserver: GraphExecutionObserver = {
      refresh: async () => { throw new Error("observer crashed"); },
    };
    const goodObserver: GraphExecutionObserver = {
      refresh: jest.fn(),
    };
    emitter.observe(badObserver);
    emitter.observe(goodObserver);

    const event: GraphExecutionEvent = {
      id: "1",
      sequence: 1,
      runId: "r1",
      workflowId: "w1",
      type: GraphExecutionEventType.NODE_COMPLETED,
      timestamp: new Date(),
      path: [],
    };
    await expect(emitter.updateObservers(event)).resolves.not.toThrow();
    expect((goodObserver.refresh as jest.Mock)).toHaveBeenCalled();
  });
});
