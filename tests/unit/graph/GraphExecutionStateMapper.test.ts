/**
 * @module as-graph/tests/unit/graph/GraphExecutionStateMapper.test
 * @summary Unit tests for the frontend-safe visual-state mapper.
 */
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
  GraphVisualState,
  graphRunTopicOf,
} from "../../../src/shared/graph";
import {
  deriveNodeVisualState,
  mapExecutionStatus,
  visualStateOfEvent,
} from "../../../src/shared/graph";
import type { GraphExecutionEvent } from "../../../src/shared/graph";

describe("GraphExecutionStateMapper", () => {
  describe("mapExecutionStatus", () => {
    it("maps RUNNING to RUNNING", () => {
      expect(mapExecutionStatus(GraphExecutionStatus.RUNNING)).toBe(
        GraphVisualState.RUNNING
      );
    });

    it("maps SUCCEEDED and CACHED to SUCCEEDED", () => {
      expect(mapExecutionStatus(GraphExecutionStatus.SUCCEEDED)).toBe(
        GraphVisualState.SUCCEEDED
      );
      expect(mapExecutionStatus(GraphExecutionStatus.CACHED)).toBe(
        GraphVisualState.SUCCEEDED
      );
    });

    it("maps FAILED to FAILED", () => {
      expect(mapExecutionStatus(GraphExecutionStatus.FAILED)).toBe(
        GraphVisualState.FAILED
      );
    });

    it("maps SKIPPED to SKIPPED", () => {
      expect(mapExecutionStatus(GraphExecutionStatus.SKIPPED)).toBe(
        GraphVisualState.SKIPPED
      );
    });

    it("collapses PENDING/PLANNING/CANCELLED/undefined to IDLE", () => {
      expect(mapExecutionStatus(GraphExecutionStatus.PENDING)).toBe(
        GraphVisualState.IDLE
      );
      expect(mapExecutionStatus(GraphExecutionStatus.PLANNING)).toBe(
        GraphVisualState.IDLE
      );
      expect(mapExecutionStatus(GraphExecutionStatus.CANCELLED)).toBe(
        GraphVisualState.IDLE
      );
      expect(mapExecutionStatus(undefined)).toBe(GraphVisualState.IDLE);
    });
  });

  describe("deriveNodeVisualState", () => {
    it("running beats everything", () => {
      expect(
        deriveNodeVisualState({ executed: true, running: true, succeeded: true })
      ).toBe(GraphVisualState.RUNNING);
    });

    it("failed node reports FAILED", () => {
      expect(deriveNodeVisualState({ executed: true, running: false, failed: true })).toBe(
        GraphVisualState.FAILED
      );
    });

    it("executed succeeded node reports SUCCEEDED", () => {
      expect(
        deriveNodeVisualState({ executed: true, running: false, succeeded: true })
      ).toBe(GraphVisualState.SUCCEEDED);
    });

    it("reachable node with incomplete upstreams reports BLOCKED", () => {
      expect(
        deriveNodeVisualState({
          executed: false,
          running: false,
          completedUpstreams: 1,
          upstreamCount: 2,
          reachable: true,
        })
      ).toBe(GraphVisualState.BLOCKED);
    });

    it("unexecuted reachable node with all upstreams complete reports IDLE", () => {
      expect(
        deriveNodeVisualState({
          executed: false,
          running: false,
          completedUpstreams: 2,
          upstreamCount: 2,
          reachable: true,
        })
      ).toBe(GraphVisualState.IDLE);
    });

    it("unexecuted node after a failed run reports SKIPPED", () => {
      expect(
        deriveNodeVisualState({
          executed: false,
          running: false,
          upstreamCount: 0,
          runFailed: true,
        })
      ).toBe(GraphVisualState.SKIPPED);
    });
  });

  describe("visualStateOfEvent", () => {
    it("maps NODE_STATE_CHANGED payload to the carried visual state", () => {
      const event = {
        type: GraphExecutionEventType.NODE_STATE_CHANGED,
        payload: { state: GraphVisualState.FAILED, nodeId: "a", runId: "r", workflowId: "w" },
      } as GraphExecutionEvent;
      expect(visualStateOfEvent(event)).toBe(GraphVisualState.FAILED);
    });

    it("maps EDGE_STATE_CHANGED payload to the carried visual state", () => {
      const event = {
        type: GraphExecutionEventType.EDGE_STATE_CHANGED,
        payload: { state: GraphVisualState.RUNNING, edgeId: "e1", runId: "r", workflowId: "w" },
      } as GraphExecutionEvent;
      expect(visualStateOfEvent(event)).toBe(GraphVisualState.RUNNING);
    });

    it("maps NODE_STARTED to RUNNING when no visual state is carried", () => {
      const event = { type: GraphExecutionEventType.NODE_STARTED } as GraphExecutionEvent;
      expect(visualStateOfEvent(event)).toBe(GraphVisualState.RUNNING);
    });
  });

  describe("graphRunTopicOf", () => {
    it("maps GRAPH_RUN_LOG to the log sub-topic", () => {
      expect(graphRunTopicOf(GraphExecutionEventType.GRAPH_RUN_LOG)).toBe(
        "graph.run.log"
      );
    });

    it("maps state-change events to the state sub-topic", () => {
      expect(
        graphRunTopicOf(GraphExecutionEventType.NODE_STATE_CHANGED)
      ).toBe("graph.run.state");
      expect(
        graphRunTopicOf(GraphExecutionEventType.EDGE_STATE_CHANGED)
      ).toBe("graph.run.state");
    });

    it("falls back to the shared topic", () => {
      expect(graphRunTopicOf(GraphExecutionEventType.NODE_STARTED)).toBe(
        "graph.run"
      );
    });
  });
});
