/**
 * @module as-graph/tests/unit/graph/CodeNodeTimeoutClamp.test
 * @summary Unit tests for the Code node sandbox-timeout clamp (SAA-2079 M1).
 * @description Covers the `clampGraphCodeTimeoutMs` helper directly and its
 * wiring through `CodeNode.execute`, including the backend environment ceiling
 * override (`GraphEnvironment.graph.execution.maxCodeTimeoutMs`).
 */
import {
  clampGraphCodeTimeoutMs,
  CodeNode,
  GRAPH_CODE_DEFAULT_TIMEOUT_MS,
} from "../../../src/node";
import { GRAPH_CODE_MAX_TIMEOUT_MS } from "../../../src/engine/constants";
import { GraphEnvironment } from "../../../src/engine/services/GraphEnvironment";
import { GraphExecutionContext } from "../../../src/engine/execution/GraphExecutionContext";
import type { CodeSandboxEvaluator } from "../../../src/engine/execution/CodeSandboxEvaluator";
import type { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import type {
  GraphNodeInstance,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import type { GraphResolvedNodeManifest } from "../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "./engine-fixtures";

/** Records the timeout the Code node forwards to the sandbox evaluator. */
function recordingEvaluator(): {
  evaluator: CodeSandboxEvaluator;
  timeouts: number[];
} {
  const timeouts: number[] = [];
  const evaluator: CodeSandboxEvaluator = {
    evaluate: (ctx) => {
      timeouts.push(ctx.timeoutMs as number);
      return "ok";
    },
  };
  return { evaluator, timeouts };
}

function engineWith(
  codeSandboxEvaluator?: CodeSandboxEvaluator
): GraphExecutionEngine {
  return { codeSandboxEvaluator } as unknown as GraphExecutionEngine;
}

function buildContext(
  engine: GraphExecutionEngine,
  nodeParameters: Record<string, unknown> = {}
): GraphExecutionContext {
  const node: GraphNodeInstance = {
    id: "CodeNode",
    kind: "core.utility.code",
    parameters: nodeParameters as never,
  };
  const document: GraphWorkflowDocument = {
    id: "wf",
    name: "wf",
    inputs: [],
    outputs: [],
    nodes: [],
    edges: [],
  };
  const manifest: GraphResolvedNodeManifest = {
    kind: "core.utility.code",
    display: { name: "Code" },
    inputs: [],
    outputs: [],
    parameters: [],
  };
  return new GraphExecutionContext(
    "run-1",
    undefined,
    "wf",
    document,
    node,
    manifest,
    ["CodeNode"],
    async () => {},
    {},
    engine
  );
}

async function runWithTimeout(
  nodeParameters: Record<string, unknown>
): Promise<number[]> {
  const { evaluator, timeouts } = recordingEvaluator();
  const ctx = buildContext(engineWith(evaluator), nodeParameters);
  await executeNode(CodeNode, nodeExecutionRequest({ code: "return 1;" }), ctx);
  return timeouts;
}

describe("clampGraphCodeTimeoutMs (SAA-2079 M1)", () => {
  it("passes a timeout within the ceiling through unchanged", () => {
    expect(clampGraphCodeTimeoutMs(2500, GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(2500);
    expect(clampGraphCodeTimeoutMs(2500, GRAPH_CODE_MAX_TIMEOUT_MS)).not.toBe(
      GRAPH_CODE_DEFAULT_TIMEOUT_MS
    );
  });

  it("clamps a timeout above the ceiling to the ceiling", () => {
    expect(clampGraphCodeTimeoutMs(50000, GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(
      GRAPH_CODE_MAX_TIMEOUT_MS
    );
    expect(clampGraphCodeTimeoutMs(5000, 2000)).toBe(2000);
  });

  it("floors a fractional timeout", () => {
    expect(clampGraphCodeTimeoutMs(2500.9, GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(2500);
  });

  it("falls back to the node default for missing, NaN, or non-positive values", () => {
    expect(clampGraphCodeTimeoutMs(undefined, GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(
      GRAPH_CODE_DEFAULT_TIMEOUT_MS
    );
    expect(clampGraphCodeTimeoutMs(null, GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(
      GRAPH_CODE_DEFAULT_TIMEOUT_MS
    );
    expect(clampGraphCodeTimeoutMs(NaN, GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(
      GRAPH_CODE_DEFAULT_TIMEOUT_MS
    );
    expect(clampGraphCodeTimeoutMs(0, GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(
      GRAPH_CODE_DEFAULT_TIMEOUT_MS
    );
    expect(clampGraphCodeTimeoutMs(-5, GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(
      GRAPH_CODE_DEFAULT_TIMEOUT_MS
    );
    expect(clampGraphCodeTimeoutMs(Infinity, GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(
      GRAPH_CODE_DEFAULT_TIMEOUT_MS
    );
  });

  it("treats numeric strings as numbers", () => {
    expect(clampGraphCodeTimeoutMs("2500", GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(2500);
    expect(clampGraphCodeTimeoutMs("40000", GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(
      GRAPH_CODE_MAX_TIMEOUT_MS
    );
  });
});

describe("CodeNode timeout clamp wiring (SAA-2079 M1)", () => {
  afterAll(() => {
    GraphEnvironment.accumulate({
      graph: { execution: { maxCodeTimeoutMs: GRAPH_CODE_MAX_TIMEOUT_MS } },
    } as never);
  });

  it("forwards a within-limit timeout unchanged", async () => {
    const timeouts = await runWithTimeout({ timeoutMs: 2500 });
    expect(timeouts).toEqual([2500]);
  });

  it("clamps an over-limit timeout to the default ceiling", async () => {
    const timeouts = await runWithTimeout({ timeoutMs: 50000 });
    expect(timeouts).toEqual([GRAPH_CODE_MAX_TIMEOUT_MS]);
  });

  it("falls back to the node default when timeoutMs is missing or invalid", async () => {
    expect(await runWithTimeout({})).toEqual([GRAPH_CODE_DEFAULT_TIMEOUT_MS]);
    expect(await runWithTimeout({ timeoutMs: 0 })).toEqual([
      GRAPH_CODE_DEFAULT_TIMEOUT_MS,
    ]);
    expect(await runWithTimeout({ timeoutMs: -1 })).toEqual([
      GRAPH_CODE_DEFAULT_TIMEOUT_MS,
    ]);
  });

  it("clamps to a smaller configured environment ceiling", async () => {
    GraphEnvironment.accumulate({
      graph: { execution: { maxCodeTimeoutMs: 2000 } },
    } as never);
    const timeouts = await runWithTimeout({ timeoutMs: 5000 });
    expect(timeouts).toEqual([2000]);
  });
});
