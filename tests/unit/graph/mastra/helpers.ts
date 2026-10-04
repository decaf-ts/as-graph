/**
 * @module as-graph/tests/unit/graph/mastra/helpers
 * @summary Shared fixtures and stubs for the `./mastra` driver suite (SAA-201).
 * @description Keeps the driver tests declarative: documents come from the
 * canonical as-graph builders, step handlers wrap real `@mastra/core` steps, and
 * the event sink records every partial event a bridge or backend emits.
 */
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import type {
  GraphExecutionEvent,
  GraphWorkflowDocument,
} from "../../../../src/shared/graph";
import type {
  GraphExecutionEventSink,
  GraphFrameAwareEventSink,
} from "../../../../src/engine/execution/GraphExecutionBackend";
import type { GraphExecutionFrame } from "../../../../src/engine/execution/GraphExecutionFrame";
import type { MastraNodeStepHandler } from "../../../../src/mastra/types";
import { document, edge, node } from "../../../fixtures/workflows/builders";

/**
 * A minimal {@link MastraNodeStepHandler} that builds a real `@mastra/core`
 * step whose id is the requested `stepId` (the node id).
 */
export function leafHandler(kind: string): MastraNodeStepHandler {
  return {
    kind,
    createStep: (_node, { stepId }) =>
      createStep({
        id: stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async () => ({}),
      }),
  };
}

/**
 * A canonical two-leaf document (`first -> second`) built with the as-graph
 * document builders.
 */
export function twoLeafDocument(): GraphWorkflowDocument {
  return document({
    id: "mastra-two-leaf",
    name: "mastra-two-leaf",
    nodes: [node("first", "test.leaf"), node("second", "test.leaf")],
    edges: [edge("e1", ["node", "first", "out"], ["node", "second", "in"])],
  });
}

/**
 * A canonical document carrying a single suspendable `core.flow.humanApproval`
 * node with a declared, non-degraded `resumeSchema`.
 */
export function humanApprovalDocument(): GraphWorkflowDocument {
  return document({
    id: "mastra-human-approval",
    name: "mastra-human-approval",
    nodes: [
      node("approve", "core.flow.humanApproval", {
        message: "Approve?",
        resumeSchema: {
          type: "object",
          properties: { approved: { type: "boolean" } },
        },
      }),
    ],
  });
}

/** A sink that records every partial event it receives, in order. */
export interface RecordingSink {
  events: Partial<GraphExecutionEvent>[];
  sink: GraphExecutionEventSink;
}

/** Builds a {@link RecordingSink}. */
export function recordingSink(): RecordingSink {
  const events: Partial<GraphExecutionEvent>[] = [];
  return {
    events,
    sink: {
      emit: async (event) => {
        events.push(event);
      },
      updateObservers: async () => {},
    },
  };
}

/**
 * A frame-bound sink stub for `MastraGraphExecutionBackend.execute`, which only
 * reads `frame.runId`/`frame.finish()` and `buildGraphExecutionResult`.
 */
export function frameBoundSink(): {
  events: Partial<GraphExecutionEvent>[];
  sink: GraphFrameAwareEventSink;
} {
  const events: Partial<GraphExecutionEvent>[] = [];
  const frame = {
    runId: "mastra-run-1",
    valueStore: { getWorkflowValues: () => ({}) },
    nodeResults: new Map(),
    events: [],
    startedAt: new Date(),
    finishedAt: undefined as Date | undefined,
    finish: () => {
      frame.finishedAt = new Date();
    },
  };
  return {
    events,
    sink: {
      frame: frame as unknown as GraphExecutionFrame,
      eventFactory: undefined as never,
      engine: undefined as never,
      emit: async (event) => {
        events.push(event);
      },
      updateObservers: async () => {},
      bindFrame: () => {},
    },
  };
}

/** Returns the graph code of a thrown `GraphExecutionError`, or `undefined`. */
export function graphCodeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { graphCode?: string }).graphCode;
  }
}
