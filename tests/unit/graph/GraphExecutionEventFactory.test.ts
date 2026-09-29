/**
 * @module as-graph/tests/unit/graph/GraphExecutionEventFactory.test
 * @summary Unit tests for the graph execution event factory.
 * @description Covers unique/incrementing event population and the SAA-1950 F6
 * fail-closed event id generation: `create()` throws a
 * {@link GraphExecutionError} with graphCode `GRAPH_EVENT_ID_ERROR` when
 * `crypto.randomUUID` is unavailable, rather than falling back to a predictable,
 * guessable id.
 */
import { afterEach, describe, it, expect } from "@jest/globals";

import { GraphExecutionEventFactory } from "../../../src/engine/events";
import { GraphExecutionError } from "../../../src/engine/errors";
import { GraphExecutionEventType } from "../../../src/shared/graph";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("GraphExecutionEventFactory", () => {
  it("creates events with unique ids, incrementing sequence, and timestamp", () => {
    const factory = new GraphExecutionEventFactory();
    const event1 = factory.create({
      runId: "r1",
      workflowId: "w1",
      type: GraphExecutionEventType.NODE_STARTED,
      path: [],
    });
    const event2 = factory.create({
      runId: "r1",
      workflowId: "w1",
      type: GraphExecutionEventType.NODE_COMPLETED,
      path: [],
    });

    expect(event1.id).not.toBe(event2.id);
    expect(event1.sequence).toBe(1);
    expect(event2.sequence).toBe(2);
    expect(event1.timestamp).toBeInstanceOf(Date);
    expect(event2.timestamp).toBeInstanceOf(Date);
  });

  it("preserves provided fields", () => {
    const factory = new GraphExecutionEventFactory();
    const event = factory.create({
      runId: "r1",
      workflowId: "w1",
      type: GraphExecutionEventType.NODE_OUTPUT,
      nodeId: "node1",
      path: ["root", "node1"],
      payload: { data: 42 },
    });

    expect(event.runId).toBe("r1");
    expect(event.workflowId).toBe("w1");
    expect(event.nodeId).toBe("node1");
    expect(event.path).toEqual(["root", "node1"]);
    expect(event.payload).toEqual({ data: 42 });
  });

  describe("event id generation (SAA-1950 F6)", () => {
    const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "crypto"
    );

    afterEach(() => {
      if (originalCryptoDescriptor) {
        Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
      } else {
        delete (globalThis as { crypto?: unknown }).crypto;
      }
    });

    it("fails loudly with a GraphExecutionError (GRAPH_EVENT_ID_ERROR) when crypto.randomUUID is unavailable", () => {
      Object.defineProperty(globalThis, "crypto", {
        value: undefined,
        configurable: true,
      });

      const factory = new GraphExecutionEventFactory();

      let thrown: unknown;
      try {
        factory.create({
          runId: "r1",
          workflowId: "w1",
          type: GraphExecutionEventType.NODE_STARTED,
          path: [],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(GraphExecutionError);
      expect((thrown as GraphExecutionError).graphCode).toBe(
        "GRAPH_EVENT_ID_ERROR"
      );
    });

    it("returns unique UUID event ids when crypto.randomUUID is available", () => {
      const factory = new GraphExecutionEventFactory();
      const event1 = factory.create({
        runId: "r1",
        workflowId: "w1",
        type: GraphExecutionEventType.NODE_STARTED,
        path: [],
      });
      const event2 = factory.create({
        runId: "r1",
        workflowId: "w1",
        type: GraphExecutionEventType.NODE_COMPLETED,
        path: [],
      });

      expect(event1.id).toMatch(UUID_PATTERN);
      expect(event1.id).toHaveLength(36);
      expect(event1.id).not.toBe(event2.id);
      // and it is not a predictable fallback id
      expect(event1.id).not.toMatch(/^event[-_]?\d+/i);
    });
  });
});
