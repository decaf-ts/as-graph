/**
 * @module as-graph/tests/integration/mastra/helpers
 * @summary Shared fixtures for the real `@mastra/core` integration suite
 * (SAA-307).
 * @description Keeps the integration tests declarative and honest about the
 * seam. The document/engine side reuses the canonical as-graph builders and the
 * existing engine fixtures; the Mastra side builds **real** `@mastra/core`
 * workflows, steps, and runs backed by a real `InMemoryStore`. Only the two
 * things the production backend deliberately delegates to a host are injected here:
 * the frame-bound event sink and the `MastraSuspendStateReader` port.
 */
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { Context } from "@decaf-ts/core";
import type { GraphExecutionEvent } from "../../../src/shared/graph";
import type { GraphFrameAwareEventSink } from "../../../src/engine/execution/GraphExecutionBackend";
import type { GraphExecutionFrame } from "../../../src/engine/execution/GraphExecutionFrame";
import type { GraphExecutionObserver } from "../../../src/engine/events/GraphExecutionObserver";
import { MastraWorkflowCompiler } from "../../../src/mastra/MastraWorkflowCompiler";
import type { MastraNodeStepHandler } from "../../../src/mastra/types";
import {
  document,
  edge,
  node,
} from "../../fixtures/workflows/builders";

/** A recorded step invocation, proving a real Mastra step executed. */
export interface StepCall {
  /** The Mastra step id (the canonical node id). */
  stepId: string;
  /** The Mastra-native `inputData` handed to the step. */
  inputData: Record<string, unknown>;
}

/** The default leaf executor: echo the input under the canonical `out` port. */
function defaultLeafExecute(
  inputData: Record<string, unknown>
): Record<string, unknown> {
  return { out: inputData };
}

/**
 * Builds a real {@link MastraNodeStepHandler}: a `createStep`-backed handler
 * whose `execute` records the call and returns the configured output.
 *
 * @param kind - The document node kind to translate.
 * @param execute - Optional real executor; defaults to echoing `out`.
 * @param calls - Optional recording sink for every real step invocation.
 * @returns A host step handler wrapping a real `@mastra/core` step.
 */
export function realStepHandler(
  kind: string,
  execute?: (inputData: Record<string, unknown>, stepId: string) => unknown,
  calls: StepCall[] = []
): MastraNodeStepHandler {
  return {
    kind,
    createStep: (_node, { stepId }) =>
      createStep({
        id: stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: { inputData?: unknown }) => {
          const inputData = (args.inputData ?? {}) as Record<string, unknown>;
          calls.push({ stepId, inputData });
          return (execute ?? defaultLeafExecute)(inputData, stepId);
        },
      }),
  };
}

/** A host-injected frame-bound sink plus the observer it dispatches to. */
export interface FrameSinkHarness {
  /** Every partial event emitted by the bridge/backend, in order. */
  events: Partial<GraphExecutionEvent>[];
  /** Every event delivered to the registered observer, in order. */
  observed: GraphExecutionEvent[];
  /** The observer registered on the sink's dispatch path. */
  observer: GraphExecutionObserver;
  /** The frame-bound sink handed to the backend. */
  sink: GraphFrameAwareEventSink;
  /** The host frame the sink is bound to. */
  frame: GraphExecutionFrame;
}

/**
 * Builds a host-injected frame-bound event sink that records emitted events and
 * dispatches them to a recording observer. This is the only piece of the event
 * pipeline the production backend does not own: `GraphExecutionEngine` normally
 * creates the frame-bound sink, but a direct backend/engine integration drives the
 * same shape so the real bridge output can be observed.
 *
 * @param runId - The canonical run id to bind onto the frame.
 * @returns The harness with events, observed events, observer, sink, and frame.
 */
export function frameSinkHarness(runId = "mastra-it-run"): FrameSinkHarness {
  const events: Partial<GraphExecutionEvent>[] = [];
  const observed: GraphExecutionEvent[] = [];
  const observer: GraphExecutionObserver = {
    refresh: async (event) => {
      observed.push(event);
    },
  };
  const frame = {
    runId,
    valueStore: { getWorkflowValues: () => ({}) },
    nodeResults: new Map(),
    events: [],
    startedAt: new Date(),
    finishedAt: undefined as Date | undefined,
    finish: () => {
      frame.finishedAt = new Date();
    },
  };
  const sink: GraphFrameAwareEventSink = {
    frame: frame as unknown as GraphExecutionFrame,
    eventFactory: undefined as never,
    engine: undefined as never,
    emit: async (event) => {
      events.push(event);
      await observer.refresh(event as GraphExecutionEvent);
    },
    updateObservers: async (event) => {
      await observer.refresh(event);
    },
    bindFrame: () => {},
  };
  return {
    events,
    observed,
    observer,
    sink,
    frame: frame as unknown as GraphExecutionFrame,
  };
}

/**
 * Builds a real `@mastra/core` runtime backed by a real `InMemoryStore`, with
 * the given workflow registered. Registration + storage are required for a
 * suspended run to be resumable: the run snapshot is persisted by Mastra.
 *
 * @param workflowId - The canonical workflow id to register under.
 * @param workflow - The real committed Mastra workflow to register.
 * @returns The real `Mastra` runtime.
 */
export function realMastraWithWorkflow(
  workflowId: string,
  workflow: unknown
): Mastra {
  return new Mastra({
    storage: new InMemoryStore(),
    workflows: { [workflowId]: workflow as never },
  });
}

/**
 * Compiles a canonical document into a real committed Mastra workflow through the
 * production compiler, using the supplied host step handlers.
 *
 * @param source - The canonical document to compile.
 * @param stepHandlers - Host step handlers used for leaf translation.
 * @returns The production compiler and its compiled workflow.
 */
export function compileDocument(
  source: Parameters<MastraWorkflowCompiler["compile"]>[0],
  stepHandlers: MastraNodeStepHandler[]
): { compiler: MastraWorkflowCompiler; compiled: ReturnType<MastraWorkflowCompiler["compile"]> } {
  const compiler = new MastraWorkflowCompiler({ stepHandlers });
  return { compiler, compiled: compiler.compile(source) };
}

/**
 * A canonical two-leaf document (`first -> second`) wired through the canonical
 * `out`/`in` ports, so the real bridge can route an edge value.
 */
export function integrationTwoLeafDocument() {
  return document({
    id: "mastra-it-two-leaf",
    name: "mastra-it-two-leaf",
    nodes: [node("first", "test.leaf"), node("second", "test.leaf")],
    edges: [edge("e1", ["node", "first", "out"], ["node", "second", "in"])],
  });
}

/**
 * A canonical document with a single suspendable `core.flow.humanApproval` node and
 * a declared, non-degraded `resumeSchema`.
 */
export function integrationHumanApprovalDocument() {
  return document({
    id: "mastra-it-human-approval",
    name: "mastra-it-human-approval",
    nodes: [
      node("approve", "core.flow.humanApproval", {
        message: "Approve?",
        approvers: ["reviewer"],
        resumeSchema: {
          type: "object",
          properties: { approved: { type: "boolean" } },
        },
      }),
    ],
  });
}

/**
 * A decaf {@link Context} carrying the authenticated `user` principal the C23
 * ownership predicate resolves.
 *
 * @param user - The principal to bind onto the context.
 * @returns The context carrying the user.
 */
export function userContext(user: string): Context {
  return new Context().accumulate({
    user,
    timestamp: new Date(),
  }) as Context;
}

/**
 * Collects every raw event from a real Mastra run stream.
 *
 * @param stream - The `fullStream` async iterable.
 * @returns The raw events, in order.
 */
export async function collectStream(
  stream: AsyncIterable<Record<string, unknown>>
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
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

/** Resolves the graph code of a rejected async call, or `undefined`. */
export async function rejectionGraphCodeOf(
  fn: () => Promise<unknown>
): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as { graphCode?: string }).graphCode;
  }
}
