/**
 * @module as-graph/tests/integration/mastra/MastraParallelTopology
 * @summary SAA-1548 acceptance: parallel topology compilation in the production
 * `MastraWorkflowCompiler` and run behaviour through the real
 * `MastraGraphExecutionBackend`.
 * @description Real-vs-injected note. **Real**: the production
 * `MastraWorkflowCompiler`, real `@mastra/core` `createStep`/`createWorkflow`
 * graphs, real committed runs (`createRun`/`stream`/`fullStream`), the production
 * `MastraEventBridge`, `MastraRunConcurrencyLimiter`, and
 * `MastraGraphExecutionBackend`. **Host-injected**: the frame-bound event sink
 * (the engine normally creates it) and the leaf `stepHandlers` the host owns.
 * Timings use real `setTimeout` delays inside real Mastra steps, so overlap is
 * observed rather than mocked.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { MastraWorkflowCompiler } from "../../../src/mastra/MastraWorkflowCompiler";
import { MastraEventBridge } from "../../../src/mastra/MastraEventBridge";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { mastraCapabilityOf } from "../../../src/mastra/MastraCapabilities";
import {
  GRAPH_MASTRA_EXECUTE_ABORTED,
  GRAPH_MASTRA_UNSUPPORTED_TOPOLOGY,
  type MastraNodeStepHandler,
} from "../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import type { MastraCompiledWorkflow } from "../../../src/mastra/MastraWorkflowCompiler";
import { document, edge, node } from "../../../src/workflows/builders";
import { frameSinkHarness, type FrameSinkHarness } from "./helpers";

const NODE_KIND = "test.parallel";

/** One real step execution, with its wall-clock interval. */
interface StepRecord {
  stepId: string;
  inputData: Record<string, unknown>;
  startedAt: number;
  finishedAt?: number;
}

/**
 * Builds a real `@mastra/core` step handler that records its interval and waits
 * for the node-id-specific delay before returning the node-id-shaped output.
 */
function timedHandler(
  records: StepRecord[],
  delays: Record<string, number> = {},
  output: (stepId: string, inputData: Record<string, unknown>) => unknown = (
    stepId
  ) => ({ out: stepId })
): MastraNodeStepHandler {
  return {
    kind: NODE_KIND,
    createStep: (_node, { stepId }) =>
      createStep({
        id: stepId,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: { inputData?: unknown }) => {
          const record: StepRecord = {
            stepId,
            inputData: (args.inputData ?? {}) as Record<string, unknown>,
            startedAt: Date.now(),
          };
          records.push(record);
          try {
            const delay = delays[stepId] ?? 0;
            if (delay > 0) {
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
            return output(stepId, record.inputData);
          } finally {
            record.finishedAt = Date.now();
          }
        },
      }),
  };
}

/** Returns the named record, failing loudly when the step never ran. */
function recordOf(records: StepRecord[], stepId: string): StepRecord {
  const record = records.find((entry) => entry.stepId === stepId);
  expect(record).toBeDefined();
  return record!;
}

/** Whether two recorded step intervals overlapped in wall-clock time. */
function overlapped(left: StepRecord, right: StepRecord): boolean {
  expect(left.finishedAt).toBeDefined();
  expect(right.finishedAt).toBeDefined();
  return (
    left.startedAt < right.finishedAt! && right.startedAt < left.finishedAt!
  );
}

/** The serialized entry list of a committed Mastra workflow. */
function graphOf(workflow: unknown): Array<Record<string, any>> {
  const candidate = workflow as {
    serializedStepGraph?: Array<Record<string, any>>;
  };
  return candidate?.serializedStepGraph ?? [];
}

/** Node-step ids grouped by each native `parallel` entry in the workflow graph. */
function parallelGroups(workflow: unknown): string[][] {
  return graphOf(workflow)
    .filter((entry) => entry["type"] === "parallel")
    .map((entry) =>
      ((entry["steps"] ?? []) as Array<Record<string, any>>)
        .map(
          (step) =>
            (step["step"]?.id ?? step["id"] ?? step["stepId"]) as
              | string
              | undefined
        )
        .filter((id): id is string => typeof id === "string")
    );
}

/** Runs a compiled workflow to completion while bridging its real stream. */
async function runCompiled(
  compiled: MastraCompiledWorkflow,
  source: GraphWorkflowDocument,
  inputs: Record<string, unknown>,
  runId: string
): Promise<FrameSinkHarness> {
  const harness = frameSinkHarness(runId);
  const bridge = new MastraEventBridge({
    runId,
    workflowId: source.id,
    document: source,
    sink: harness.sink,
  });
  const run = await (
    compiled.workflow as {
      createRun: (options?: unknown) => Promise<{
        getResult?: () => Promise<unknown>;
        stream: (options?: unknown) => Promise<{
          fullStream?: AsyncIterable<Record<string, unknown>>;
          result?: Promise<unknown>;
        }>;
      }>;
    }
  ).createRun({ runId });
  const stream = await run.stream({ inputData: inputs });
  if (stream.fullStream) await bridge.attach(stream.fullStream);
  if (typeof run.getResult === "function") {
    await run.getResult();
  } else if (stream.result) {
    await stream.result;
  }
  return harness;
}

/** The event types a harness recorded for one node id. */
function eventTypesFor(
  harness: FrameSinkHarness,
  nodeId: string
): string[] {
  return harness.events
    .filter((event) => event.nodeId === nodeId)
    .map((event) => String(event.type));
}

/** A minimal non-empty foreach body used by the branch-activated-loop case. */
function loopBodyDocument(): GraphWorkflowDocument {
  return document({
    id: "mastra-parallel-loop-body",
    name: "mastra-parallel-loop-body",
    nodes: [node("body-leaf", NODE_KIND)],
    edges: [edge("be1", ["workflow", "item"], ["node", "body-leaf", "in"])],
  });
}

describe("Mastra parallel topology compilation (SAA-1548 §4)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("compiles independent siblings to a native parallel entry that overlaps execution", async () => {
    const source = document({
      id: "mastra-parallel-overlap",
      name: "mastra-parallel-overlap",
      nodes: [node("a", NODE_KIND), node("b", NODE_KIND)],
    });
    const records: StepRecord[] = [];
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [timedHandler(records, { a: 150, b: 150 })],
    });

    const compiled = compiler.compile(source);
    expect(compiled.layers).toEqual([["a", "b"]]);
    expect(parallelGroups(compiled.workflow)).toEqual([["a", "b"]]);
    for (const nodeId of ["a", "b"]) {
      expect(
        (compiled.steps.get(nodeId) as { metadata?: Record<string, unknown> })
          .metadata?.["decafNode"]
      ).toEqual({ id: nodeId, kind: NODE_KIND });
    }

    const harness = await runCompiled(compiled, source, {}, "parallel-overlap");
    const a = recordOf(records, "a");
    const b = recordOf(records, "b");
    const elapsed =
      Math.max(a.finishedAt!, b.finishedAt!) -
      Math.min(a.startedAt, b.startedAt);

    expect(harness.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        GraphExecutionEventType.WORKFLOW_STARTED,
        GraphExecutionEventType.NODE_COMPLETED,
        GraphExecutionEventType.WORKFLOW_COMPLETED,
      ])
    );
    // Both real steps were in flight at the same time, and the run did not pay
    // the sum of their delays.
    expect(overlapped(a, b)).toBe(true);
    expect(elapsed).toBeLessThan(a.finishedAt! - a.startedAt + b.finishedAt! - b.startedAt);
    // Only real document nodes reach the event bridge; router/mapping entries
    // are internal to the compiled workflow and never masquerade as nodes.
    const nodeIds = new Set(source.nodes.map((entry) => entry.id));
    expect(
      harness.events
        .map((event) => event.nodeId)
        .filter((nodeId): nodeId is string => typeof nodeId === "string")
        .every((nodeId) => nodeIds.has(nodeId))
    ).toBe(true);
  });

  it("keeps a dependent chain ordered while an unrelated sibling runs in the first layer", async () => {
    const source = document({
      id: "mastra-parallel-chain",
      name: "mastra-parallel-chain",
      nodes: [
        node("first", NODE_KIND),
        node("side", NODE_KIND),
        node("second", NODE_KIND),
      ],
      edges: [edge("e1", ["node", "first", "out"], ["node", "second", "in"])],
    });
    const records: StepRecord[] = [];
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [timedHandler(records, { first: 80, side: 80, second: 10 })],
    });

    const compiled = compiler.compile(source);
    expect(compiled.layers).toEqual([["first", "side"], ["second"]]);
    expect(parallelGroups(compiled.workflow)).toEqual([["first", "side"]]);

    await runCompiled(compiled, source, {}, "parallel-chain");
    const first = recordOf(records, "first");
    const side = recordOf(records, "side");
    const second = recordOf(records, "second");

    expect(overlapped(first, side)).toBe(true);
    expect(second.startedAt).toBeGreaterThanOrEqual(first.finishedAt!);
    expect(second.startedAt).toBeGreaterThanOrEqual(side.finishedAt!);
    expect(second.inputData).toEqual({ in: "first" });
  });

  it("routes fan-out/fan-in values by port identity regardless of completion order", async () => {
    const source = document({
      id: "mastra-parallel-fan",
      name: "mastra-parallel-fan",
      nodes: [
        node("source", NODE_KIND),
        node("left", NODE_KIND),
        node("right", NODE_KIND),
        node("join", NODE_KIND),
      ],
      edges: [
        edge("e1", ["node", "source", "a"], ["node", "left", "in"]),
        edge("e2", ["node", "source", "b"], ["node", "right", "in"]),
        edge("e3", ["node", "left", "out"], ["node", "join", "left"]),
        edge("e4", ["node", "right", "out"], ["node", "join", "right"]),
      ],
    });
    const records: StepRecord[] = [];
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [
        timedHandler(
          records,
          { left: 180, right: 30 },
          (stepId, inputData) => {
            if (stepId === "source") return { a: "alpha", b: "beta" };
            if (stepId === "left") return { out: `left:${inputData["in"]}` };
            if (stepId === "right") return { out: `right:${inputData["in"]}` };
            return { joined: inputData };
          }
        ),
      ],
    });

    const compiled = compiler.compile(source);
    expect(compiled.layers).toEqual([
      ["source"],
      ["left", "right"],
      ["join"],
    ]);

    await runCompiled(compiled, source, {}, "parallel-fan");
    const left = recordOf(records, "left");
    const right = recordOf(records, "right");
    const join = recordOf(records, "join");

    // Asymmetric delays prove the right arm finished first.
    expect(right.finishedAt!).toBeLessThan(left.finishedAt!);
    expect(left.inputData).toEqual({ in: "alpha" });
    expect(right.inputData).toEqual({ in: "beta" });
    // The join receives each routed value on its graph target port, not the
    // last-completing source's payload.
    expect(join.inputData).toEqual({
      left: "left:alpha",
      right: "right:beta",
    });
  });

  it("compiles a nested loop body with independent siblings to a parallel group and overlaps", async () => {
    const body = document({
      id: "mastra-parallel-nested-loop-body",
      name: "mastra-parallel-nested-loop-body",
      nodes: [node("body-a", NODE_KIND), node("body-b", NODE_KIND)],
      edges: [
        edge("be1", ["workflow", "item"], ["node", "body-a", "in"]),
        edge("be2", ["workflow", "item"], ["node", "body-b", "in"]),
      ],
    });
    const source = document({
      id: "mastra-parallel-nested-loop",
      name: "mastra-parallel-nested-loop",
      nodes: [
        node(
          "loop",
          "core.loop.foreach",
          { itemPort: "item", resultPort: "result" },
          { loop: { body } }
        ),
      ],
      edges: [edge("e1", ["workflow", "items"], ["node", "loop", "items"])],
    });
    const records: StepRecord[] = [];
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [timedHandler(records, { "body-a": 150, "body-b": 150 })],
    });

    const compiled = compiler.compile(source);
    expect(compiled.layers).toEqual([["loop"]]);
    const loopStep = compiled.steps.get("loop") as {
      steps: Record<string, { steps: Record<string, unknown> | undefined }>;
    };
    const bodyInput = loopStep.steps["loop::body-input"];
    const compiledBody = bodyInput.steps[body.id];
    expect(compiledBody).toBeDefined();
    expect(parallelGroups(compiledBody)).toEqual([["body-a", "body-b"]]);

    await runCompiled(compiled, source, { items: [1] }, "parallel-nested-loop");
    const a = recordOf(records, "body-a");
    const b = recordOf(records, "body-b");
    const elapsed =
      Math.max(a.finishedAt!, b.finishedAt!) -
      Math.min(a.startedAt, b.startedAt);

    expect(overlapped(a, b)).toBe(true);
    expect(elapsed).toBeLessThan(
      a.finishedAt! - a.startedAt + b.finishedAt! - b.startedAt
    );
    expect(a.inputData).toEqual({ in: 1 });
    expect(b.inputData).toEqual({ in: 1 });
  });

  it("preserves branch selection and skips the unselected parallel arm", async () => {
    const condition = {
      op: "eq",
      left: { path: "value" },
      right: { const: true },
    };
    const source = document({
      id: "mastra-parallel-branch",
      name: "mastra-parallel-branch",
      nodes: [
        node("branch", "core.flow.if", { condition: condition as never, else: true }),
        node("then-1", NODE_KIND),
        node("then-2", NODE_KIND),
        node("else-1", NODE_KIND),
        node("else-2", NODE_KIND),
        node("join", NODE_KIND),
      ],
      edges: [
        edge("e0", ["workflow", "value"], ["node", "branch", "value"]),
        edge("e1", ["node", "branch", "then"], ["node", "then-1", "in"]),
        edge("e2", ["node", "branch", "then"], ["node", "then-2", "in"]),
        edge("e3", ["node", "branch", "else"], ["node", "else-1", "in"]),
        edge("e4", ["node", "branch", "else"], ["node", "else-2", "in"]),
        edge("e5", ["node", "then-1", "out"], ["node", "join", "then-1"]),
        edge("e6", ["node", "then-2", "out"], ["node", "join", "then-2"]),
        edge("e7", ["node", "else-1", "out"], ["node", "join", "else-1"]),
        edge("e8", ["node", "else-2", "out"], ["node", "join", "else-2"]),
      ],
    });
    const records: StepRecord[] = [];
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [timedHandler(records)],
    });
    const compiled = compiler.compile(source);

    const selected = await runCompiled(
      compiled,
      source,
      { value: true },
      "parallel-branch-then"
    );
    expect(recordOf(records, "then-1")).toBeDefined();
    expect(recordOf(records, "then-2")).toBeDefined();
    expect(records.some((record) => record.stepId === "else-1")).toBe(false);
    expect(records.some((record) => record.stepId === "else-2")).toBe(false);
    for (const nodeId of ["else-1", "else-2"]) {
      expect(eventTypesFor(selected, nodeId)).toContain(
        GraphExecutionEventType.NODE_SKIPPED
      );
      expect(eventTypesFor(selected, nodeId)).not.toContain(
        GraphExecutionEventType.NODE_COMPLETED
      );
    }
    const join = recordOf(records, "join");
    expect(join.inputData).toEqual({
      "then-1": "then-1",
      "then-2": "then-2",
    });

    records.length = 0;
    const unselected = await runCompiled(
      compiled,
      source,
      { value: false },
      "parallel-branch-else"
    );
    expect(recordOf(records, "else-1")).toBeDefined();
    expect(recordOf(records, "else-2")).toBeDefined();
    expect(records.some((record) => record.stepId === "then-1")).toBe(false);
    expect(records.some((record) => record.stepId === "then-2")).toBe(false);
    for (const nodeId of ["then-1", "then-2"]) {
      expect(eventTypesFor(unselected, nodeId)).toContain(
        GraphExecutionEventType.NODE_SKIPPED
      );
      expect(eventTypesFor(unselected, nodeId)).not.toContain(
        GraphExecutionEventType.NODE_COMPLETED
      );
    }
    const joinElse = recordOf(records, "join");
    expect(joinElse.inputData).toEqual({
      "else-1": "else-1",
      "else-2": "else-2",
    });
  });

  it("fails compilation of a loop conditionally activated by a branch", () => {
    const condition = {
      op: "eq",
      left: { const: true },
      right: { const: true },
    };
    const source = document({
      id: "mastra-parallel-branched-loop",
      name: "mastra-parallel-branched-loop",
      nodes: [
        node("branch", "core.flow.if", { condition: condition as never, else: true }),
        node(
          "loop",
          "core.loop.foreach",
          { itemPort: "item", resultPort: "result" },
          { loop: { body: loopBodyDocument() } }
        ),
      ],
      edges: [
        edge("e1", ["node", "branch", "then"], ["node", "loop", "items"]),
      ],
    });
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [timedHandler([])],
    });

    let code: string | undefined;
    try {
      compiler.compile(source);
    } catch (error) {
      code = (error as { graphCode?: string }).graphCode;
    }
    expect(code).toBe(GRAPH_MASTRA_UNSUPPORTED_TOPOLOGY);
  });

  it("bounds active parallel executions by the run concurrency ceiling without serializing the group", async () => {
    const source = document({
      id: "mastra-parallel-ceiling",
      name: "mastra-parallel-ceiling",
      nodes: [
        node("slow", NODE_KIND),
        node("short", NODE_KIND),
        node("middle", NODE_KIND),
      ],
    });
    const records: StepRecord[] = [];
    let active = 0;
    let maxActive = 0;
    const handler: MastraNodeStepHandler = {
      kind: NODE_KIND,
      createStep: (_node, { stepId }) =>
        createStep({
          id: stepId,
          inputSchema: z.any(),
          outputSchema: z.any(),
          execute: async (args: { inputData?: unknown }) => {
            const record: StepRecord = {
              stepId,
              inputData: (args.inputData ?? {}) as Record<string, unknown>,
              startedAt: Date.now(),
            };
            records.push(record);
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
              await new Promise((resolve) =>
                setTimeout(resolve, stepId === "slow" ? 250 : stepId === "short" ? 80 : 150)
              );
              return { out: stepId };
            } finally {
              active -= 1;
              record.finishedAt = Date.now();
            }
          },
        }),
    };
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {}, stepHandlers: [handler] });
    const harness = frameSinkHarness("parallel-ceiling");

    const result = await backend.execute({
      document: source,
      plan: undefined as never,
      inputs: {},
      options: { concurrency: 2 } as never,
      events: harness.sink,
    });
    const slow = recordOf(records, "slow");
    const short = recordOf(records, "short");
    const middle = recordOf(records, "middle");
    const startedAt = Math.min(slow.startedAt, short.startedAt, middle.startedAt);
    const finishedAt = Math.max(slow.finishedAt!, short.finishedAt!, middle.finishedAt!);

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(maxActive).toBe(2);
    // The freed slot starts the queued node while the slow member is still
    // running: the limiter does not split the logical parallel group into
    // serialized waves [slow, short] then [middle].
    expect(middle.startedAt).toBeLessThan(slow.finishedAt!);
    expect(short.finishedAt!).toBeLessThan(slow.finishedAt!);
    expect(finishedAt - startedAt).toBeLessThan(340);
  });

  it("fails the whole parallel run when one member fails, with valid terminal event sequencing", async () => {
    const source = document({
      id: "mastra-parallel-failure",
      name: "mastra-parallel-failure",
      nodes: [
        node("ok-1", NODE_KIND),
        node("boom", NODE_KIND),
        node("ok-2", NODE_KIND),
      ],
    });
    const handler: MastraNodeStepHandler = {
      kind: NODE_KIND,
      createStep: (_node, { stepId }) =>
        createStep({
          id: stepId,
          inputSchema: z.any(),
          outputSchema: z.any(),
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (stepId === "boom") {
              throw new Error("parallel member exploded");
            }
            return { out: stepId };
          },
        }),
    };
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {}, stepHandlers: [handler] });
    const harness = frameSinkHarness("parallel-failure");

    const result = await backend.execute({
      document: source,
      plan: undefined as never,
      inputs: {},
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    const types = harness.events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.NODE_FAILED);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_FAILED);
    expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_COMPLETED);
    const failedNode = harness.events.find(
      (event) =>
        event.type === GraphExecutionEventType.NODE_FAILED &&
        event.nodeId === "boom"
    );
    expect(failedNode).toBeDefined();
    const workflowTypes = types.filter((type) =>
      String(type).startsWith("workflow.")
    );
    expect(workflowTypes).toEqual([
      GraphExecutionEventType.WORKFLOW_STARTED,
      GraphExecutionEventType.WORKFLOW_FAILED,
    ]);
  });

  it("aborts a parallel run when the caller cancels it", async () => {
    const source = document({
      id: "mastra-parallel-abort",
      name: "mastra-parallel-abort",
      nodes: [node("hang-1", NODE_KIND), node("hang-2", NODE_KIND)],
    });
    const handler: MastraNodeStepHandler = {
      kind: NODE_KIND,
      createStep: (_node, { stepId }) =>
        createStep({
          id: stepId,
          inputSchema: z.any(),
          outputSchema: z.any(),
          execute: async () => new Promise(() => {}),
        }),
    };
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: {},
      stepHandlers: [handler],
      terminalTimeoutMs: 60_000,
    });
    const harness = frameSinkHarness("parallel-abort");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);

    const result = await backend.execute({
      document: source,
      plan: undefined as never,
      inputs: {},
      options: { abortSignal: controller.signal } as never,
      events: harness.sink,
    });
    clearTimeout(timer);

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    const failed = harness.events.find(
      (event) => event.type === GraphExecutionEventType.WORKFLOW_FAILED
    ) as { error?: { code?: string } } | undefined;
    expect(failed).toBeDefined();
    expect(failed?.error?.code).toBe(GRAPH_MASTRA_EXECUTE_ABORTED);
    expect(harness.events.map((event) => event.type)).not.toContain(
      GraphExecutionEventType.WORKFLOW_COMPLETED
    );
  });

  it("executes a non-branch node when an upstream output omits the declared source port", async () => {
    // Only branch-sensitive nodes may be gated as unselected arms. A regular
    // dependency whose source omitted a port must still execute (with an
    // undefined input value), otherwise a failing node is silently skipped and
    // the run reports a false success.
    const source = document({
      id: "mastra-parallel-missing-port",
      name: "mastra-parallel-missing-port",
      nodes: [node("upstream", NODE_KIND), node("downstream", NODE_KIND)],
      edges: [edge("e1", ["node", "upstream", "declared"], ["node", "downstream", "in"])],
    });
    const records: StepRecord[] = [];
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [
        timedHandler(records, {}, (stepId) =>
          stepId === "upstream" ? { other: "value" } : { out: "ran" }
        ),
      ],
    });
    const compiled = compiler.compile(source);

    const harness = await runCompiled(
      compiled,
      source,
      {},
      "parallel-missing-port"
    );

    expect(records.some((record) => record.stepId === "downstream")).toBe(true);
    const downstream = recordOf(records, "downstream");
    expect(
      Object.prototype.hasOwnProperty.call(downstream.inputData, "in")
    ).toBe(true);
    expect(downstream.inputData["in"]).toBeUndefined();
    expect(eventTypesFor(harness, "downstream")).not.toContain(
      GraphExecutionEventType.NODE_SKIPPED
    );
    expect(eventTypesFor(harness, "downstream")).toContain(
      GraphExecutionEventType.NODE_COMPLETED
    );
  });

  it("declares the parallel capability SUPPORTED in the exported table", () => {
    expect(mastraCapabilityOf("parallel")?.verdict).toBe("SUPPORTED");
  });
});
