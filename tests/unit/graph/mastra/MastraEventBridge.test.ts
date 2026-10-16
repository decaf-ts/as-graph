/**
 * @module as-graph/tests/unit/graph/mastra/MastraEventBridge
 * @summary Driver tests for `MastraEventBridge` (SAA-201 case 2).
 * @description Drives synthetic Mastra `fullStream` events and asserts the
 * `fullStream` → `GraphExecutionEventType`/status mapping oracle, the
 * `workflow-step-result` failure split, and edge-state derivation from the
 * document's declared routing.
 */
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
  GraphVisualState,
} from "../../../../src/shared/graph/constants";
import type { GraphExecutionEvent } from "../../../../src/shared/graph";
import { MastraEventBridge } from "../../../../src/mastra/MastraEventBridge";
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import { document, edge, node } from "../../../../src/workflows/builders";
import { recordingSink } from "./helpers";

const source = document({
  id: "mastra-event-bridge",
  name: "mastra-event-bridge",
  nodes: [node("a", "test.leaf"), node("b", "test.leaf")],
  edges: [
    edge("e1", ["node", "a", "out"], ["node", "b", "in"], "data"),
    edge("e2", ["node", "a", "out"], ["node", "b", "in"], "connection"),
  ],
});

function summary(events: Partial<GraphExecutionEvent>[]) {
  return events.map((event) => ({
    type: event.type,
    status: event.status,
    nodeId: event.nodeId,
    edgeId: event.edgeId,
    iteration: event.iteration,
  }));
}

async function drive(
  event: Record<string, unknown>,
  workflow: GraphWorkflowDocument = source
): Promise<Partial<GraphExecutionEvent>[]> {
  const { sink, events } = recordingSink();
  const bridge = new MastraEventBridge({
    runId: "run-1",
    workflowId: workflow.id,
    document: workflow,
    sink,
  });
  await bridge.handle(event);
  return events;
}

describe("MastraEventBridge", () => {
  it("maps workflow lifecycle events onto workflow event types", async () => {
    expect(summary(await drive({ type: "workflow-start" }))).toEqual([
      {
        type: GraphExecutionEventType.WORKFLOW_STARTED,
        status: GraphExecutionStatus.RUNNING,
        nodeId: undefined,
        edgeId: undefined,
        iteration: undefined,
      },
    ]);

    expect(summary(await drive({ type: "workflow-canceled" }))).toEqual([
      {
        type: GraphExecutionEventType.WORKFLOW_CANCELLED,
        status: GraphExecutionStatus.CANCELLED,
        nodeId: undefined,
        edgeId: undefined,
        iteration: undefined,
      },
    ]);

    expect(
      summary(
        await drive({
          type: "workflow-finish",
          payload: { workflowStatus: "success", finalWorkflowResult: { r: 1 } },
        })
      )
    ).toEqual([
      {
        type: GraphExecutionEventType.WORKFLOW_COMPLETED,
        status: GraphExecutionStatus.SUCCEEDED,
        nodeId: undefined,
        edgeId: undefined,
        iteration: undefined,
      },
    ]);

    expect(
      summary(
        await drive({
          type: "workflow-finish",
          payload: { workflowStatus: "failed", error: { message: "boom" } },
        })
      )
    ).toEqual([
      {
        type: GraphExecutionEventType.WORKFLOW_FAILED,
        status: GraphExecutionStatus.FAILED,
        nodeId: undefined,
        edgeId: undefined,
        iteration: undefined,
      },
    ]);

    expect(
      summary(
        await drive({
          type: "workflow-finish",
          payload: { workflowStatus: "canceled" },
        })
      )
    ).toEqual([
      {
        type: GraphExecutionEventType.WORKFLOW_CANCELLED,
        status: GraphExecutionStatus.CANCELLED,
        nodeId: undefined,
        edgeId: undefined,
        iteration: undefined,
      },
    ]);
  });

  it("maps step start/output/progress events and derives incoming edge state", async () => {
    expect(
      summary(
        await drive({
          type: "workflow-step-start",
          payload: { id: "b" },
        })
      )
    ).toEqual([
      {
        type: GraphExecutionEventType.NODE_STARTED,
        status: GraphExecutionStatus.RUNNING,
        nodeId: "b",
        edgeId: undefined,
        iteration: undefined,
      },
      {
        type: GraphExecutionEventType.NODE_STATE_CHANGED,
        status: GraphExecutionStatus.RUNNING,
        nodeId: "b",
        edgeId: undefined,
        iteration: undefined,
      },
      {
        type: GraphExecutionEventType.EDGE_STATE_CHANGED,
        status: GraphExecutionStatus.RUNNING,
        nodeId: "a",
        edgeId: "e1",
        iteration: undefined,
      },
    ]);

    expect(
      summary(
        await drive({
          type: "workflow-step-output",
          payload: { id: "a", output: { out: 7 } },
        })
      )
    ).toEqual([
      {
        type: GraphExecutionEventType.NODE_OUTPUT,
        status: GraphExecutionStatus.RUNNING,
        nodeId: "a",
        edgeId: undefined,
        iteration: undefined,
      },
    ]);

    expect(
      summary(
        await drive({
          type: "workflow-step-progress",
          payload: {
            id: "a",
            currentIndex: 2,
            iterationStatus: "failed",
            completedCount: 1,
            totalCount: 3,
          },
        })
      )
    ).toEqual([
      {
        type: GraphExecutionEventType.LOOP_ITERATION_COMPLETED,
        status: GraphExecutionStatus.FAILED,
        nodeId: "a",
        edgeId: undefined,
        iteration: 2,
      },
    ]);

    expect(
      summary(
        await drive({
          type: "workflow-step-progress",
          payload: { id: "a", currentIndex: 1, iterationStatus: "success" },
        })
      )
    ).toEqual([
      {
        type: GraphExecutionEventType.LOOP_ITERATION_COMPLETED,
        status: GraphExecutionStatus.SUCCEEDED,
        nodeId: "a",
        edgeId: undefined,
        iteration: 1,
      },
    ]);
  });

  it("splits workflow-step-result success, failure, and suspension", async () => {
    expect(
      summary(
        await drive({
          type: "workflow-step-result",
          payload: { id: "a", status: "success", output: { out: 9 } },
        })
      )
    ).toEqual([
      {
        type: GraphExecutionEventType.NODE_COMPLETED,
        status: GraphExecutionStatus.SUCCEEDED,
        nodeId: "a",
        edgeId: undefined,
        iteration: undefined,
      },
      {
        type: GraphExecutionEventType.NODE_STATE_CHANGED,
        status: GraphExecutionStatus.SUCCEEDED,
        nodeId: "a",
        edgeId: undefined,
        iteration: undefined,
      },
      {
        type: GraphExecutionEventType.EDGE_VALUE_ROUTED,
        status: GraphExecutionStatus.SUCCEEDED,
        nodeId: "a",
        edgeId: "e1",
        iteration: undefined,
      },
      {
        type: GraphExecutionEventType.EDGE_STATE_CHANGED,
        status: GraphExecutionStatus.SUCCEEDED,
        nodeId: "a",
        edgeId: "e1",
        iteration: undefined,
      },
    ]);

    expect(
      summary(
        await drive({
          type: "workflow-step-result",
          payload: { id: "a", status: "failed", error: { message: "boom" } },
        })
      )
    ).toEqual([
      {
        type: GraphExecutionEventType.NODE_FAILED,
        status: GraphExecutionStatus.FAILED,
        nodeId: "a",
        edgeId: undefined,
        iteration: undefined,
      },
      {
        type: GraphExecutionEventType.NODE_STATE_CHANGED,
        status: GraphExecutionStatus.FAILED,
        nodeId: "a",
        edgeId: undefined,
        iteration: undefined,
      },
    ]);

    const suspended = await drive({
      type: "workflow-step-result",
      payload: { id: "a", status: "suspended" },
    });
    expect(summary(suspended)).toEqual([
      {
        type: GraphExecutionEventType.NODE_STATE_CHANGED,
        status: GraphExecutionStatus.RUNNING,
        nodeId: "a",
        edgeId: undefined,
        iteration: undefined,
      },
    ]);
    expect(suspended[0].payload).toEqual({
      nodeId: "a",
      state: GraphVisualState.BLOCKED,
      runId: "run-1",
      workflowId: source.id,
    });
  });

  it("does not route outgoing edges when the result output omits the source port", async () => {
    const { sink, events } = recordingSink();
    const bridge = new MastraEventBridge({
      runId: "run-1",
      workflowId: source.id,
      document: source,
      sink,
    });

    await bridge.handle({
      type: "workflow-step-result",
      payload: { id: "a", status: "success", output: { other: 1 } },
    });

    expect(events.map((event) => event.type)).toEqual([
      GraphExecutionEventType.NODE_COMPLETED,
      GraphExecutionEventType.NODE_STATE_CHANGED,
    ]);
  });

  it("maps workflow-step-suspended onto node state + workflow suspended", async () => {
    const events = await drive({
      type: "workflow-step-suspended",
      payload: { id: "a", suspendPayload: { question: "ok?" } },
    });

    expect(summary(events)).toEqual([
      {
        type: GraphExecutionEventType.NODE_STATE_CHANGED,
        status: GraphExecutionStatus.RUNNING,
        nodeId: "a",
        edgeId: undefined,
        iteration: undefined,
      },
      {
        type: GraphExecutionEventType.WORKFLOW_SUSPENDED,
        status: GraphExecutionStatus.PENDING,
        nodeId: "a",
        edgeId: undefined,
        iteration: undefined,
      },
    ]);
    expect(events[1].payload).toEqual({ suspend: { question: "ok?" } });
  });

  it("maps log/writer/console and log-shaped fallbacks to graph run logs", async () => {
    for (const type of ["log", "writer", "console"]) {
      const events = await drive({
        type,
        payload: { level: "warn", message: "hello", nodeId: "a" },
      });
      expect(summary(events)).toEqual([
        {
          type: GraphExecutionEventType.GRAPH_RUN_LOG,
          status: GraphExecutionStatus.RUNNING,
          nodeId: "a",
          edgeId: undefined,
          iteration: undefined,
        },
      ]);
      expect((events[0].payload as { level: string }).level).toBe("warn");
      expect((events[0].payload as { message: string }).message).toBe("hello");
    }

    const fallback = await drive({
      type: "some-unknown-event",
      payload: { level: "info", message: "fallback" },
    });
    expect(summary(fallback)).toEqual([
      {
        type: GraphExecutionEventType.GRAPH_RUN_LOG,
        status: GraphExecutionStatus.RUNNING,
        nodeId: undefined,
        edgeId: undefined,
        iteration: undefined,
      },
    ]);

    expect(
      await drive({ type: "log", payload: { level: "nope", message: "x" } })
    ).toEqual([]);
    expect(await drive({ type: "some-unknown-event", payload: {} })).toEqual([]);
  });

  it("drives an async iterable through attach()", async () => {
    const { sink, events } = recordingSink();
    const bridge = new MastraEventBridge({
      runId: "run-1",
      workflowId: source.id,
      document: source,
      sink,
    });

    async function* stream() {
      yield { type: "workflow-start" };
      yield { type: "workflow-step-start", payload: { id: "a" } };
    }

    await bridge.attach(stream());

    expect(events.map((event) => event.type)).toEqual([
      GraphExecutionEventType.WORKFLOW_STARTED,
      GraphExecutionEventType.NODE_STARTED,
      GraphExecutionEventType.NODE_STATE_CHANGED,
    ]);
  });
});
