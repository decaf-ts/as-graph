/**
 * @module as-graph/tests/unit/graph/GraphExecutionEngine.test
 * @summary End-to-end unit tests for the graph execution engine.
 * @description DECAF-50 §4.9 contract: the engine executes canonical
 * `GraphWorkflowDocument`s only, performing validation and resolution
 * internally.
 */
import { Context, type ContextualArgs } from "@decaf-ts/core";
import { GraphExecutionEventType } from "../../../src/shared/graph";
import type {
  GraphInputBinding,
  GraphNodeManifest,
  GraphNodeCapability,
  GraphNodePolicyManifest,
  GraphJsonValue,
  GraphPortManifest,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";

import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { GraphNodeCatalogue } from "../../../src/engine/catalog/GraphNodeCatalogue";
import { defineGraphNode } from "../../../src/engine/catalog/GraphNodeRegistration";
import { registerBuiltInGraphNodes } from "../../../src/engine/catalog/GraphBuiltInRegistrations";
import { GraphExecutionPlanner } from "../../../src/engine/planning/GraphExecutionPlanner";
import type {
  CodeSandboxEvaluator,
  CodeSandboxContext,
} from "../../../src/engine/execution/CodeSandboxEvaluator";
import type {
  GraphExecutionEvent,
  GraphNodeExecutionRequest,
} from "../../../src/engine/types";
import { GraphDocumentValidationError } from "../../../src/engine/validation/GraphValidationErrors";
import { GraphWorkflowDocumentValidator } from "../../../src/engine/validation/GraphWorkflowDocumentValidator";
import type { GraphValidationIssue } from "../../../src/engine/validation/GraphValidationIssue";

import {
  bootEngine,
  cyclicDocument,
  demoCatalogue,
  documentEdge,
  documentNode,
  documentPort,
  freshCatalogue,
  linearDocument,
  resolveDocument,
} from "./engine-fixtures";

describe("GraphExecutionEngine", () => {
  async function buildEngine(executors?: Record<string, unknown>): Promise<{
    engine: GraphExecutionEngine;
    events: GraphExecutionEvent[];
  }> {
    const registry = new GraphNodeExecutorRegistry(
      await demoCatalogue(
        (executors as never) ?? undefined
      )
    );
    const events: GraphExecutionEvent[] = [];
    const engine = await bootEngine({ registry });
    engine.observe({
      refresh: async (event) => { events.push(event); },
    });
    return { engine, events };
  }

  it("executes a canonical document and produces correct outputs", async () => {
    const { engine } = await buildEngine();
    const result = await engine.execute(linearDocument(), { a: 2, b: 3 });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe(10); // (2+3) * 2
    expect(result.nodeResults.adder.outputs?.sum).toBe(5);
    expect(result.nodeResults.multiplier.outputs?.product).toBe(10);
  });

  it("rejects a document that fails the nine-stage validation gate", async () => {
    const { engine } = await buildEngine();
    await expect(engine.execute(cyclicDocument(), {})).rejects.toThrow(
      GraphDocumentValidationError
    );
  });

  it("emits validation started and completed events", async () => {
    const { engine, events } = await buildEngine();
    await engine.execute(linearDocument(), { a: 1, b: 1 });

    const types = events.map((e) => e.type);
    expect(types).toContain(GraphExecutionEventType.VALIDATION_STARTED);
    expect(types).toContain(GraphExecutionEventType.VALIDATION_COMPLETED);
  });

  it("emits workflow started, planned, and completed events", async () => {
    const { engine, events } = await buildEngine();
    await engine.execute(linearDocument(), { a: 1, b: 1 });

    const types = events.map((e) => e.type);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_STARTED);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_PLANNED);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_COMPLETED);
  });

  it("emits node started and completed events for each node", async () => {
    const { engine, events } = await buildEngine();
    await engine.execute(linearDocument(), { a: 1, b: 1 });

    const started = events.filter(
      (e) => e.type === GraphExecutionEventType.NODE_STARTED
    );
    const completed = events.filter(
      (e) => e.type === GraphExecutionEventType.NODE_COMPLETED
    );
    expect(started.length).toBe(2);
    expect(completed.length).toBe(2);
  });

  it("emits edge value routed events", async () => {
    const { engine, events } = await buildEngine();
    await engine.execute(linearDocument(), { a: 1, b: 1 });

    const routed = events.filter(
      (e) => e.type === GraphExecutionEventType.EDGE_VALUE_ROUTED
    );
    // adder->multiplier and multiplier->workflow.result are routed;
    // boundary->adder edges are read in resolveNodeInputs, not routed.
    expect(routed.length).toBe(2);
  });

  it("captures a failed node and reports the error", async () => {
    const { engine } = await buildEngine({
      "math.add": { execute: () => { throw new Error("addition failed"); } },
      "math.multiply": {
        execute: (request: GraphNodeExecutionRequest) => ({
          product: Number(request.inputs.x),
        }),
      },
    } as never);

    const result = await engine.execute(linearDocument(), { a: 1, b: 1 });

    expect(result.status).toBe("failed");
    expect(result.nodeResults.adder.error?.message).toBe("addition failed");
  });

  it("applies skip semantics to disabled nodes", async () => {
    const document = linearDocument();
    (document.nodes[0] as { disabled?: boolean }).disabled = true;
    const { engine } = await buildEngine();

    const result = await engine.execute(document, { a: 2, b: 3 });

    expect(result.nodeResults.adder.status).toBe("skipped");
    expect(result.nodeResults.adder.outputs).toBeUndefined();
  });

  it("applies passThroughFirstInput semantics to disabled nodes", async () => {
    const document = linearDocument();
    const adder = document.nodes[0];
    adder.disabled = true;
    adder.metadata = { disabledBehavior: "passThroughFirstInput" };
    const { engine } = await buildEngine();

    const result = await engine.execute(document, { a: 2, b: 3 });

    // First incoming edge value (workflow.a) forwarded on the first output
    // (the placeholder manifest declares no outputs, so the `value` fallback
    // port is used).
    expect(result.nodeResults.adder.outputs?.value).toBe(2);
  });

  it("returns a runId and records timing", async () => {
    const { engine } = await buildEngine();
    const result = await engine.execute(linearDocument(), { a: 1, b: 1 });

    expect(result.runId).toBeTruthy();
    expect(result.startedAt).toBeInstanceOf(Date);
    expect(result.finishedAt).toBeInstanceOf(Date);
  });

  it("events have unique ids and incrementing sequence numbers", async () => {
    const { engine, events } = await buildEngine();
    await engine.execute(linearDocument(), { a: 1, b: 1 });

    const ids = new Set(events.map((e) => e.id));
    expect(ids.size).toBe(events.length);
    const seqs = events.map((e) => e.sequence);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it("supports custom runId via options", async () => {
    const { engine } = await buildEngine();
    const result = await engine.execute(linearDocument(), { a: 1, b: 1 }, {
      runId: "custom-run",
    });
    expect(result.runId).toBe("custom-run");
  });

  it("observer failures do not crash execution", async () => {
    const registry = new GraphNodeExecutorRegistry(await demoCatalogue());
    const engine = await bootEngine({ registry });
    engine.observe({
      refresh: async () => { throw new Error("observer crashed"); },
    });

    const result = await engine.execute(linearDocument(), { a: 1, b: 1 });
    expect(result.status).toBe("succeeded");
  });
});

/**
 * DECAF-50 §4.19 "Planner and engine" named suite (§4.20 P3 gate).
 *
 * These tests exercise the P3 engine-resolution contract through the real
 * engine pipeline so every assertion covers the exact implementation surface
 * that runs in production:
 *
 * - executors resolve through the catalogue (plan nodes carry the catalogue
 *   executor; no execute-time kind resolution);
 * - parameters/inputs separation (§4.9 `GraphNodeExecutionRequest`: the
 *   sole executor contract post-cutover);
 * - binding application (literal bindings, manifest defaults, expression
 *   bindings only via the configured `CodeSandboxEvaluator`);
 * - output validation against the effective output manifest;
 * - disabled-node semantics (`skip` / `passThroughFirstInput` / `emitDefaults`
 *   — instance metadata, then document settings, then default);
 * - nested loops (loop bodies validated recursively and executed through the
 *   same engine pipeline; capability stage 9 rejects loop config on
 *   non-loop kinds).
 */

/** A strict-kind port spec for §4.19 fixtures (DECAF-50 §4.9 renderer ports). */
interface NamedTestPortSpec {
  id: string;
  required?: boolean;
  /** Declares the port default; the engine applies it when no edge/binding provides the value. */
  defaultValue?: GraphJsonValue;
}

function namedTestPortSpec(
  id: string,
  direction: "input" | "output",
  spec: NamedTestPortSpec = {}
): GraphPortManifest {
  const manifest: GraphPortManifest = { id, label: id, direction };
  if (spec.required !== undefined) {
    manifest.required = spec.required;
  }
  if (spec.defaultValue !== undefined) {
    manifest.metadata = { defaultValue: spec.defaultValue };
  }
  return manifest;
}

interface NamedTestKindSpec {
  kind: string;
  inputs?: NamedTestPortSpec[];
  outputs?: NamedTestPortSpec[];
  capabilities?: GraphNodeCapability[];
  policies?: GraphNodePolicyManifest;
  executor: { execute: (request: GraphNodeExecutionRequest) => unknown };
}

/**
 * Registers a kind through the strict catalogue path (no transition
 * leniency) so §4.19 output-validation and capability assertions run on the
 * DECAF-50 target behaviour, never on placeholder-manifest leniency.
 */
async function registerNamedTestKind(
  catalogue: GraphNodeCatalogue,
  spec: NamedTestKindSpec
): Promise<void> {
  const manifest: GraphNodeManifest = {
    kind: spec.kind,
    display: { name: spec.kind },
    inputs: (spec.inputs ?? []).map((port) =>
      namedTestPortSpec(port.id, "input", port)
    ),
    outputs: (spec.outputs ?? []).map((port) =>
      namedTestPortSpec(port.id, "output", port)
    ),
    parameters: [],
    ...(spec.capabilities ? { capabilities: spec.capabilities } : {}),
    ...(spec.policies ? { policies: spec.policies } : {}),
  };
  await catalogue.register(
    defineGraphNode({
      manifest,
      executor: spec.executor as never,
    })
  );
}

/**
 * Installs a resolution spy on the catalogue instance, recording every
 * `getExecutor(kind)` call. `GraphNodeCatalogue` is a `@service()` singleton, so
 * subclassing cannot intercept instance calls — an own-property wrapper can.
 */
function spyOnExecutorResolutions(catalogue: GraphNodeCatalogue): string[] {
  const resolutions: string[] = [];
  const original = catalogue.getExecutor.bind(catalogue);
  catalogue.getExecutor = (kind: string, ...args: unknown[]) => {
    resolutions.push(kind);
    return original(kind, ...(args as never[]));
  };
  return resolutions;
}

/** Legacy facade spy: the DECAF-50 engine must never call `resolve(kind)`. */
class NamedTestUntouchedRegistry extends GraphNodeExecutorRegistry {
  public resolveCalls: string[] = [];

  override resolve(kind: string, ...args: ContextualArgs<Context>) {
    this.resolveCalls.push(kind);
    return super.resolve(kind, ...args);
  }
}

/**
 * Builds a fresh engine over the given catalogue and collects every emitted
 * event (top-level and nested runs alike — nested loop bodies run through
 * the same emitter).
 */
async function namedTestEngine(
  catalogue: GraphNodeCatalogue,
  extra: { codeSandboxEvaluator?: CodeSandboxEvaluator } = {}
): Promise<{ engine: GraphExecutionEngine; events: GraphExecutionEvent[] }> {
  const events: GraphExecutionEvent[] = [];
  const engine = await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    ...(extra.codeSandboxEvaluator ? { codeSandboxEvaluator: extra.codeSandboxEvaluator } : {}),
  });
  engine.observe({
    refresh: async (event) => {
      events.push(event);
    },
  });
  return { engine, events };
}

function issueOf(
  issues: GraphValidationIssue[],
  code: string
): GraphValidationIssue | undefined {
  return issues.find((issue) => issue.code === code);
}

describe("DECAF-50 §4.19 planner/engine — engine resolution", () => {
  it("executors resolve through the catalogue: plan nodes carry the catalogue executor and the engine never resolves by kind at execute time", async () => {
    // --- Identity half: the plan carries the catalogue's executor objects.
    const identityCatalogue = freshCatalogue();
    await identityCatalogue.registerExecutor("math.add", {
      execute: (request) => ({
        sum: Number(request.inputs.a) + Number(request.inputs.b),
      }),
    });
    await identityCatalogue.registerExecutor("math.multiply", {
      execute: (request) => ({ product: Number(request.inputs.x) * 2 }),
    });
    const catalogueAddExecutor = await identityCatalogue.getExecutor("math.add");
    const catalogueMultiplyExecutor = await identityCatalogue.getExecutor("math.multiply");

    const resolved = await resolveDocument(linearDocument(), identityCatalogue);
    const plan = await new GraphExecutionPlanner().plan(resolved);
    expect(plan.nodes.find((node) => node.id === "adder")!.executor).toBe(catalogueAddExecutor);
    expect(plan.nodes.find((node) => node.id === "multiplier")!.executor).toBe(catalogueMultiplyExecutor);

    // --- No-execute-time-resolution half: during a full engine run the
    // catalogue resolves the executor exactly once per node (stage-2 kind
    // resolution) and the legacy facade `resolve(kind)` is never used.
    const counting = freshCatalogue();
    const executorResolutions = spyOnExecutorResolutions(counting);
    await counting.registerExecutor("math.add", {
      execute: (request) => ({
        sum: Number(request.inputs.a) + Number(request.inputs.b),
      }),
    });
    await counting.registerExecutor("math.multiply", {
      execute: (request) => ({ product: Number(request.inputs.x) * 2 }),
    });
    const untouchedRegistry = new NamedTestUntouchedRegistry(counting);
    const engine = await bootEngine({ registry: untouchedRegistry });
    const result = await engine.execute(linearDocument(), { a: 2, b: 3 });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe(10);
    expect(executorResolutions).toEqual(["math.add", "math.multiply"]);
    expect(untouchedRegistry.resolveCalls).toEqual([]);
  });

  it("separates parameters from inputs: every executor receives a GraphNodeExecutionRequest with configuration and input data separated (§4.9 sole contract)", async () => {
    const catalogue = freshCatalogue();
    const recordedRequests: GraphNodeExecutionRequest[] = [];

    catalogue.registerExecutor("sample.request-based", {
      execute(request) {
        recordedRequests.push(request);
        return { result: `${String(request.inputs.x)}+${String(request.parameters.scale)}` };
      },
    });

    const { engine } = await namedTestEngine(catalogue);

    const requestDocument: GraphWorkflowDocument = {
      id: "request-wf",
      name: "request-wf",
      inputs: [documentPort("x")],
      outputs: [documentPort("out")],
      nodes: [
        documentNode("n", "sample.request-based", { scale: 10 }, {
          metadata: { channel: "meta-1" },
        }),
      ],
      edges: [
        documentEdge("e1", ["workflow", "x"], ["node", "n", "x"]),
        documentEdge("e2", ["node", "n", "result"], ["workflow", "out"]),
      ],
    };
    const requestResult = await engine.execute(requestDocument, { x: "abc" });

    expect(requestResult.status).toBe("succeeded");
    expect(recordedRequests).toHaveLength(1);
    const request = recordedRequests[0];
    expect(request.nodeId).toBe("n");
    expect(request.kind).toBe("sample.request-based");
    expect(request.parameters).toEqual({ scale: 10 });
    expect(Object.keys(request.inputs).sort()).toEqual(["x"]);
    expect(request.inputs.x).toBe("abc");
    expect("scale" in request.inputs).toBe(false);
    expect(request.metadata).toEqual({ channel: "meta-1" });
    expect(request.credentials).toEqual({});
    expect(requestResult.nodeResults.n.outputs?.result).toBe("abc+10");
  });

  it("applies bindings: literal bindings feed declared ports and manifest port defaults only fill unprovided inputs", async () => {
    const catalogue = freshCatalogue();
    await registerNamedTestKind(catalogue, {
      kind: "sample.sum",
      inputs: [
        { id: "a", defaultValue: 7 },
        { id: "b", defaultValue: 3 },
      ],
      outputs: [{ id: "sum" }],
      executor: {
        execute: (request) => ({
          sum: Number(request.inputs.a) + Number(request.inputs.b),
        }),
      } as never,
    });
    const { engine } = await namedTestEngine(catalogue);

    // Literal binding feeds the declared port in place of an edge.
    const literalDocument: GraphWorkflowDocument = {
      id: "literal-wf",
      name: "literal-wf",
      inputs: [documentPort("a")],
      outputs: [documentPort("out")],
      nodes: [
        documentNode("adder", "sample.sum", {}, {
          inputBindings: { b: { mode: "literal", value: 42 } as GraphInputBinding },
        }),
      ],
      edges: [
        documentEdge("e1", ["workflow", "a"], ["node", "adder", "a"]),
        documentEdge("e2", ["node", "adder", "sum"], ["workflow", "out"]),
      ],
    };
    const literalResult = await engine.execute(literalDocument, { a: 2 });

    expect(literalResult.status).toBe("succeeded");
    expect(literalResult.nodeResults.adder.inputs.b).toBe(42);
    expect(literalResult.outputs.out).toBe(44);

    // Manifest port defaults fill unprovided inputs.
    const defaultsDocument: GraphWorkflowDocument = {
      id: "defaults-wf",
      name: "defaults-wf",
      inputs: [],
      outputs: [documentPort("out")],
      nodes: [documentNode("adder", "sample.sum")],
      edges: [documentEdge("e2", ["node", "adder", "sum"], ["workflow", "out"])],
    };
    const defaultsResult = await engine.execute(defaultsDocument, {});

    expect(defaultsResult.nodeResults.adder.inputs).toEqual({ a: 7, b: 3 });
    expect(defaultsResult.outputs.out).toBe(10);

    // ...and a routed edge wins over the declared default.
    const edgeWinsDocument: GraphWorkflowDocument = {
      id: "edge-wins-wf",
      name: "edge-wins-wf",
      inputs: [documentPort("a")],
      outputs: [documentPort("out")],
      nodes: [documentNode("adder", "sample.sum")],
      edges: [
        documentEdge("e1", ["workflow", "a"], ["node", "adder", "a"]),
        documentEdge("e2", ["node", "adder", "sum"], ["workflow", "out"]),
      ],
    };
    const edgeWinsResult = await engine.execute(edgeWinsDocument, { a: 5 });

    expect(edgeWinsResult.nodeResults.adder.inputs.a).toBe(5);
    expect(edgeWinsResult.outputs.out).toBe(8);
  });

  it("expression bindings evaluate only through the configured CodeSandboxEvaluator", async () => {
    const catalogue = freshCatalogue();
    await registerNamedTestKind(catalogue, {
      kind: "sample.echo",
      inputs: [{ id: "expressionPort" }],
      outputs: [{ id: "result" }],
      executor: {
        execute: (request) => ({ result: request.inputs.expressionPort }),
      } as never,
    });
    const evaluatorCalls: CodeSandboxContext[] = [];
    const { engine } = await namedTestEngine(catalogue, {
      codeSandboxEvaluator: {
        evaluate: async (ctx) => {
          evaluatorCalls.push(ctx);
          return `EXPR-EVAL(${ctx.code})`;
        },
      },
    });

    const evaluatedDocument: GraphWorkflowDocument = {
      id: "expression-evaluated-wf",
      name: "expression-evaluated-wf",
      inputs: [],
      outputs: [documentPort("out")],
      nodes: [
        documentNode("conv", "sample.echo", {}, {
          inputBindings: {
            expressionPort: {
              mode: "expression",
              expression: "$input.a + '!'",
            } as GraphInputBinding,
          },
        }),
      ],
      edges: [documentEdge("e2", ["node", "conv", "result"], ["workflow", "out"])],
    };
    const evaluated = await engine.execute(evaluatedDocument, {});

    expect(evaluated.status).toBe("succeeded");
    expect(evaluatorCalls).toHaveLength(1);
    expect(evaluatorCalls[0].code).toBe("$input.a + '!'");
    expect(evaluatorCalls[0].language).toBe("javascript");
    expect(evaluated.nodeResults.conv.outputs?.result).toBe(
      "EXPR-EVAL($input.a + '!')"
    );
    expect(evaluated.outputs.out).toBe("EXPR-EVAL($input.a + '!')");
  });

  it("resolves GraphValueTemplate parameters into request.parameters at execution time", async () => {
    const catalogue = freshCatalogue();
    const requests: GraphNodeExecutionRequest[] = [];
    catalogue.registerExecutor("sample.templated", {
      execute: (request) => {
        requests.push(request);
        return { result: request.parameters.level };
      },
    } as never);
    const evaluatorCalls: CodeSandboxContext[] = [];
    const { engine } = await namedTestEngine(catalogue, {
      codeSandboxEvaluator: {
        evaluate: async (ctx) => {
          evaluatorCalls.push(ctx);
          return "warn";
        },
      },
    });

    const templatedDocument: GraphWorkflowDocument = {
      id: "templated-param-wf",
      name: "templated-param-wf",
      inputs: [documentPort("x")],
      outputs: [documentPort("out")],
      nodes: [
        documentNode(
          "templated",
          "sample.templated",
          {
            level: {
              mode: "expression",
              expression: "$input.x === 'warn' ? 'warn' : 'info'",
              language: "javascript",
            },
          } as GraphJsonValue as never
        ),
      ],
      edges: [
        documentEdge("e1", ["workflow", "x"], ["node", "templated", "x"]),
        documentEdge("e2", ["node", "templated", "result"], ["workflow", "out"]),
      ],
    };
    const result = await engine.execute(templatedDocument, { x: "warn" });

    expect(result.status).toBe("succeeded");
    expect(evaluatorCalls).toHaveLength(1);
    expect(evaluatorCalls[0].code).toBe("$input.x === 'warn' ? 'warn' : 'info'");
    expect(requests).toHaveLength(1);
    expect(requests[0].parameters).toEqual({ level: "warn" });
    expect(result.outputs.out).toBe("warn");
  });

  it("expression bindings throw GRAPH_CODE_SANDBOX_NOT_CONFIGURED when the engine has no evaluator configured", async () => {
    const catalogue = freshCatalogue();
    await registerNamedTestKind(catalogue, {
      kind: "sample.echo",
      inputs: [{ id: "expressionPort" }],
      outputs: [{ id: "result" }],
      executor: {
        execute: (request) => ({ result: request.inputs.expressionPort }),
      } as never,
    });
    const { engine, events } = await namedTestEngine(catalogue);

    const evaluatedDocument: GraphWorkflowDocument = {
      id: "expression-not-configured-wf",
      name: "expression-not-configured-wf",
      inputs: [],
      outputs: [documentPort("out")],
      nodes: [
        documentNode("conv", "sample.echo", {}, {
          inputBindings: {
            expressionPort: {
              mode: "expression",
              expression: "$input.a + '!'",
            } as GraphInputBinding,
          },
        }),
      ],
      edges: [documentEdge("e2", ["node", "conv", "result"], ["workflow", "out"])],
    };
    const result = await engine.execute(evaluatedDocument, {});

    expect(result.status).toBe("failed");
    const failedEvent = events.find(
      (event) => event.type === GraphExecutionEventType.WORKFLOW_FAILED
    );
    expect((failedEvent?.error as { code?: string } | undefined)?.code).toBe(
      "GRAPH_CODE_SANDBOX_NOT_CONFIGURED"
    );
    expect(failedEvent?.error?.message).toContain(
      "Expression binding on node 'conv'"
    );
    expect(failedEvent?.error?.message).toContain(
      "GraphExecutionEngineConfig.codeSandboxEvaluator"
    );
  });

  it("validates executor outputs against the effective output manifest: unknown outputs and missing required outputs fail the node; allowUnknownOutputs is the only escape", async () => {
    const catalogue = freshCatalogue();
    await registerNamedTestKind(catalogue, {
      kind: "sample.strict-sum",
      outputs: [{ id: "sum" }],
      executor: {
        execute: () => ({ sum: 5, weird: true }),
      } as never,
    });
    await registerNamedTestKind(catalogue, {
      kind: "sample.required-sum",
      outputs: [{ id: "sum", required: true }, { id: "unit" }],
      executor: {
        execute: () => ({ unit: "u" }),
      } as never,
    });
    await registerNamedTestKind(catalogue, {
      kind: "sample.lenient-sum",
      outputs: [{ id: "sum" }],
      policies: { allowUnknownOutputs: true },
      executor: {
        execute: () => ({ sum: 5, weird: true }),
      } as never,
    });
    const { engine } = await namedTestEngine(catalogue);

    const singleKindDocument = (
      id: string,
      kind: string
    ): GraphWorkflowDocument => ({
      id,
      name: id,
      inputs: [],
      outputs: [documentPort("out")],
      nodes: [documentNode("adder", kind)],
      edges: [documentEdge("e2", ["node", "adder", "sum"], ["workflow", "out"])],
    });

    // Unknown outputs rejected by default.
    const unknownResult = await engine.execute(
      singleKindDocument("unknown-outputs-wf", "sample.strict-sum"),
      {}
    );
    expect(unknownResult.status).toBe("failed");
    expect(unknownResult.nodeResults.adder.error?.code).toBe(
      "GRAPH_OUTPUT_VALIDATION_FAILED"
    );
    expect(unknownResult.nodeResults.adder.error?.message).toContain(
      "unknown output(s): weird"
    );

    // Missing required outputs fail the node.
    const missingResult = await engine.execute(
      singleKindDocument("missing-required-wf", "sample.required-sum"),
      {}
    );
    expect(missingResult.status).toBe("failed");
    expect(missingResult.nodeResults.adder.error?.code).toBe(
      "GRAPH_OUTPUT_VALIDATION_FAILED"
    );
    expect(missingResult.nodeResults.adder.error?.message).toContain(
      "did not produce required output(s): sum"
    );

    // `allowUnknownOutputs` leniency lets the extra output through.
    const lenientResult = await engine.execute(
      singleKindDocument("lenient-outputs-wf", "sample.lenient-sum"),
      {}
    );
    expect(lenientResult.status).toBe("succeeded");
    expect(lenientResult.nodeResults.adder.outputs?.sum).toBe(5);
    expect(lenientResult.nodeResults.adder.outputs?.weird).toBe(true);
    expect(lenientResult.outputs.out).toBe(5);
  });

  it("disabled node emitDefaults behavior emits every declared output port default and never executes the node", async () => {
    const catalogue = freshCatalogue();
    let executorInvocations = 0;
    await registerNamedTestKind(catalogue, {
      kind: "sample.emit-sum",
      outputs: [{ id: "sum", defaultValue: 33 }],
      executor: {
        execute: () => {
          executorInvocations += 1;
          return { sum: "executed" };
        },
      } as never,
    });
    const { engine, events } = await namedTestEngine(catalogue);

    const document: GraphWorkflowDocument = {
      id: "emit-defaults-wf",
      name: "emit-defaults-wf",
      inputs: [],
      outputs: [documentPort("out")],
      nodes: [documentNode("adder", "sample.emit-sum", {}, { disabled: true })],
      edges: [documentEdge("e2", ["node", "adder", "sum"], ["workflow", "out"])],
      settings: { disabledBehavior: "emitDefaults" },
    };
    const result = await engine.execute(document, {});

    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.adder.status).toBe("succeeded");
    expect(result.nodeResults.adder.outputs?.sum).toBe(33);
    expect(result.outputs.out).toBe(33);
    // §4.9: the disabled node runs to its default shape, never the executor.
    expect(executorInvocations).toBe(0);
    const skippedEvent = events.find(
      (event) => event.type === GraphExecutionEventType.NODE_SKIPPED
    );
    expect((skippedEvent?.payload as { behavior?: string }).behavior).toBe(
      "emitDefaults"
    );
  });

  it("disabled node document-settings passThroughFirstInput forwards the first incoming edge value on the first declared output port", async () => {
    const catalogue = freshCatalogue();
    let executorInvocations = 0;
    await registerNamedTestKind(catalogue, {
      kind: "sample.pass",
      inputs: [{ id: "a" }],
      outputs: [{ id: "echo" }],
      executor: {
        execute: () => {
          executorInvocations += 1;
          return { echo: "executed" };
        },
      } as never,
    });
    const { engine, events } = await namedTestEngine(catalogue);

    const document: GraphWorkflowDocument = {
      id: "pass-through-wf",
      name: "pass-through-wf",
      inputs: [documentPort("a")],
      outputs: [documentPort("out")],
      nodes: [documentNode("mid", "sample.pass", {}, { disabled: true })],
      edges: [
        documentEdge("e1", ["workflow", "a"], ["node", "mid", "a"]),
        documentEdge("e2", ["node", "mid", "echo"], ["workflow", "out"]),
      ],
      settings: { disabledBehavior: "passThroughFirstInput" },
    };
    const result = await engine.execute(document, { a: 2 });

    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.mid.outputs?.echo).toBe(2);
    expect(result.outputs.out).toBe(2);
    expect(executorInvocations).toBe(0);
    const skippedEvent = events.find(
      (event) => event.type === GraphExecutionEventType.NODE_SKIPPED
    );
    expect((skippedEvent?.payload as { behavior?: string }).behavior).toBe(
      "passThroughFirstInput"
    );
  });

  it("disabled node behavior resolution: instance metadata beats document settings, which beats the skip default", async () => {
    const catalogue = freshCatalogue();
    await registerNamedTestKind(catalogue, {
      kind: "sample.emit-sum",
      outputs: [{ id: "sum", defaultValue: 33 }],
      executor: {
        execute: () => ({ sum: "executed" }),
      } as never,
    });
    const { engine, events } = await namedTestEngine(catalogue);

    // Instance metadata `skip` beats document settings `emitDefaults`.
    const overrideDocument: GraphWorkflowDocument = {
      id: "override-wf",
      name: "override-wf",
      inputs: [],
      outputs: [documentPort("out")],
      nodes: [
        documentNode("adder", "sample.emit-sum", {}, {
          disabled: true,
          metadata: { disabledBehavior: "skip" },
        }),
      ],
      edges: [documentEdge("e2", ["node", "adder", "sum"], ["workflow", "out"])],
      settings: { disabledBehavior: "emitDefaults" },
    };
    const overrideResult = await engine.execute(overrideDocument, {});

    expect(overrideResult.nodeResults.adder.status).toBe("skipped");
    expect(overrideResult.nodeResults.adder.outputs).toBeUndefined();
    expect("out" in overrideResult.outputs).toBe(false);
    const skippedPayload = (
      events.find(
        (event) =>
          event.type === GraphExecutionEventType.NODE_SKIPPED &&
          event.nodeId === "adder"
      )?.payload ?? {}
    ) as { behavior?: string };
    expect(skippedPayload.behavior).toBe("skip");

    // Document settings `emitDefaults` beats the `skip` default.
    const settingsDocument: GraphWorkflowDocument = {
      id: "settings-wf",
      name: "settings-wf",
      inputs: [],
      outputs: [documentPort("out")],
      nodes: [
        documentNode("deferred", "sample.emit-sum", {}, { disabled: true }),
      ],
      edges: [
        documentEdge("e2", ["node", "deferred", "sum"], ["workflow", "out"]),
      ],
      settings: { disabledBehavior: "emitDefaults" },
    };
    const settingsResult = await engine.execute(settingsDocument, {});

    expect(settingsResult.nodeResults.deferred.status).toBe("succeeded");
    expect(settingsResult.nodeResults.deferred.outputs?.sum).toBe(33);
    const settingsPayload = (
      events.find(
        (event) =>
          event.type === GraphExecutionEventType.NODE_SKIPPED &&
          event.nodeId === "deferred"
      )?.payload ?? {}
    ) as { behavior?: string };
    expect(settingsPayload.behavior).toBe("emitDefaults");
  });

  it("nested loop bodies execute through the same validation→resolution→planning pipeline", async () => {
    const catalogue = freshCatalogue();
    const { engine, events } = await namedTestEngine(catalogue);
    await registerBuiltInGraphNodes(catalogue);

    const bodyDocument: GraphWorkflowDocument = {
      id: "loop-body",
      name: "loop-body",
      inputs: [documentPort("item")],
      outputs: [documentPort("result")],
      nodes: [documentNode("echo", "core.flow.delay", { value: {} })],
      edges: [
        documentEdge("b1", ["workflow", "item"], ["node", "echo", "value"]),
        documentEdge("b2", ["node", "echo", "value"], ["workflow", "result"]),
      ],
    };
    const loopDocument: GraphWorkflowDocument = {
      id: "foreach-wf",
      name: "foreach-wf",
      inputs: [documentPort("in")],
      outputs: [documentPort("total")],
      nodes: [
        documentNode("loop1", "core.loop.foreach", {}, {
          loop: { body: bodyDocument } as never,
        }),
      ],
      edges: [
        documentEdge("rin", ["workflow", "in"], ["node", "loop1", "items"]),
        documentEdge("rout", ["node", "loop1", "results"], ["workflow", "total"]),
      ],
    };
    const result = await engine.execute(loopDocument, { in: [1, 2, 3] });

    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.loop1.outputs?.results).toEqual([1, 2, 3]);
    expect(result.nodeResults.loop1.outputs?.iterations).toBe(3);
    expect(result.nodeResults.loop1.outputs?.broken).toBe(false);
    expect(result.outputs.total).toEqual([1, 2, 3]);

    // The nested body ran through the full engine pipeline: its own validation
    // gate, planning events, and node execution — not a bypass execution.
    expect(
      events.some(
        (event) =>
          event.type === GraphExecutionEventType.VALIDATION_COMPLETED &&
          event.workflowId === "loop-body"
      )
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === GraphExecutionEventType.NODE_STARTED &&
          event.nodeId === "echo" &&
          event.path.join("/") === "loop1/iteration:0/echo"
      )
    ).toBe(true);
    expect(
      events.some((event) => event.type === GraphExecutionEventType.LOOP_STARTED)
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === GraphExecutionEventType.LOOP_ITERATION_STARTED &&
          event.iteration === 2
      )
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === GraphExecutionEventType.EDGE_VALUE_ROUTED &&
          event.edgeId === "b2"
      )
    ).toBe(true);
  });

  it("routes only the selected switch branch: an unselected branch is skipped and never contributes to workflow outputs (DECAF-50 §4.9)", async () => {
    const catalogue = freshCatalogue();
    const { engine } = await namedTestEngine(catalogue);
    await registerBuiltInGraphNodes(catalogue);

    const evenInvocations: unknown[] = [];
    const oddInvocations: unknown[] = [];
    await registerNamedTestKind(catalogue, {
      kind: "sample.branch-even",
      inputs: [{ id: "value" }],
      outputs: [{ id: "result" }],
      executor: {
        execute: (request: GraphNodeExecutionRequest) => {
          evenInvocations.push(request.inputs.value);
          return { result: request.inputs.value };
        },
      },
    });
    await registerNamedTestKind(catalogue, {
      kind: "sample.branch-odd",
      inputs: [{ id: "value" }],
      outputs: [{ id: "result" }],
      executor: {
        execute: (request: GraphNodeExecutionRequest) => {
          oddInvocations.push(request.inputs.value);
          return { result: request.inputs.value };
        },
      },
    });

    const branchDocument: GraphWorkflowDocument = {
      id: "switch-branch-wf",
      name: "switch-branch-wf",
      inputs: [documentPort("payload")],
      outputs: [documentPort("result")],
      nodes: [
        documentNode(
          "sw",
          "core.flow.switch",
          {
            cases: [
              {
                id: "even",
                label: "Even",
                outputPort: "even",
                condition: {
                  op: "eq",
                  left: { path: "n" },
                  right: { const: 2 },
                },
              },
            ],
            hasDefault: true,
          },
          {
            metadata: {
              switch: {
                cases: [
                  {
                    id: "even",
                    label: "Even",
                    outputPort: "even",
                    condition: {
                      op: "eq",
                      left: { path: "n" },
                      right: { const: 2 },
                    },
                  },
                ],
                defaultPort: "default",
                hasDefault: true,
              },
            },
          }
        ),
        documentNode("evenBranch", "sample.branch-even"),
        documentNode("oddBranch", "sample.branch-odd"),
      ],
      edges: [
        documentEdge("e_in", ["workflow", "payload"], ["node", "sw", "value"]),
        documentEdge(
          "e_even",
          ["node", "sw", "even"],
          ["node", "evenBranch", "value"]
        ),
        documentEdge(
          "e_odd",
          ["node", "sw", "default"],
          ["node", "oddBranch", "value"]
        ),
        documentEdge(
          "e_out_even",
          ["node", "evenBranch", "result"],
          ["workflow", "result"]
        ),
        documentEdge(
          "e_out_odd",
          ["node", "oddBranch", "result"],
          ["workflow", "result"]
        ),
      ],
    };

    const evenResult = await engine.execute(branchDocument, {
      payload: { n: 2 },
    });
    expect(evenResult.status).toBe("succeeded");
    expect(evenResult.outputs.result).toEqual({ n: 2 });
    expect(evenInvocations).toEqual([{ n: 2 }]);
    expect(oddInvocations).toEqual([]);
    expect(evenResult.nodeResults.evenBranch.status).toBe("succeeded");
    expect(evenResult.nodeResults.oddBranch.status).toBe("skipped");
    expect(evenResult.nodeResults.oddBranch.outputs).toBeUndefined();

    const oddResult = await engine.execute(branchDocument, {
      payload: { n: 3 },
    });
    expect(oddResult.status).toBe("succeeded");
    expect(oddResult.outputs.result).toEqual({ n: 3 });
    expect(oddInvocations).toEqual([{ n: 3 }]);
    expect(evenInvocations).toEqual([{ n: 2 }]);
    expect(oddResult.nodeResults.oddBranch.status).toBe("succeeded");
    expect(oddResult.nodeResults.evenBranch.status).toBe("skipped");
  });

  it("nested loop bodies are validated recursively and merged issue paths announce the owning loop node", async () => {
    const catalogue = freshCatalogue();
    const { engine } = await namedTestEngine(catalogue);
    await registerBuiltInGraphNodes(catalogue);
    const validator = new GraphWorkflowDocumentValidator({ catalogue });

    const invalidBody: GraphWorkflowDocument = {
      id: "bad-body",
      name: "bad-body",
      inputs: [],
      outputs: [],
      nodes: [
        documentNode("dup", "core.utility.map", { value: {} }),
        documentNode("dup", "core.utility.map", { value: {} }),
      ],
      edges: [],
    };
    const loopDocument: GraphWorkflowDocument = {
      id: "foreach-invalid-body-wf",
      name: "foreach-invalid-body-wf",
      inputs: [],
      outputs: [],
      nodes: [
        documentNode("loop1", "core.loop.foreach", {}, {
          loop: { body: invalidBody } as never,
        }),
      ],
      edges: [],
    };

    const validation = await validator.validate(loopDocument);
    expect(validation.valid).toBe(false);
    expect(validation.resolved).toBeUndefined();
    const duplicateIssues = (validation.issues ?? []).filter(
      (issue) => issue.code === "document.duplicate-node-id"
    );
    expect(duplicateIssues).toHaveLength(1);
    expect(duplicateIssues[0].path).toBe(
      "nodes[loop1].loop.body.nodes[dup]"
    );
    expect(duplicateIssues[0].nodeId).toBe("dup");

    // The engine's fail-fast gate carries the same structured issues.
    let thrown: unknown;
    try {
      await engine.execute(loopDocument, {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GraphDocumentValidationError);
    const nestedIssue = (thrown as GraphDocumentValidationError).issues.find(
      (issue) => issue.code === "document.duplicate-node-id"
    );
    expect(nestedIssue?.path).toBe("nodes[loop1].loop.body.nodes[dup]");
  });

  it("capability stage 9 rejects loop configuration on kinds that do not declare the loop capability", async () => {
    const catalogue = freshCatalogue();
    await registerNamedTestKind(catalogue, {
      kind: "sample.sum",
      inputs: [{ id: "a" }, { id: "b" }],
      outputs: [{ id: "sum" }],
      executor: {
        execute: (request) => ({
          sum: Number(request.inputs.a) + Number(request.inputs.b),
        }),
      } as never,
    });
    const { engine } = await namedTestEngine(catalogue);
    const validator = new GraphWorkflowDocumentValidator({ catalogue });

    const loopDocument: GraphWorkflowDocument = {
      id: "loop-on-non-loop-wf",
      name: "loop-on-non-loop-wf",
      inputs: [],
      outputs: [],
      nodes: [
        documentNode("adder", "sample.sum", {}, {
          loop: {
            body: {
              id: "loop-body",
              name: "loop-body",
              inputs: [],
              outputs: [],
              nodes: [],
              edges: [],
            },
          } as never,
        }),
      ],
      edges: [],
    };

    const validation = await validator.validate(loopDocument);
    expect(validation.valid).toBe(false);
    const issue = issueOf(validation.issues ?? [], "capability.loop-not-supported");
    expect(issue?.nodeId).toBe("adder");
    expect(issue?.path).toBe("nodes[adder].loop");
    expect(issue?.message).toContain("does not declare the 'loop' capability");

    let thrown: unknown;
    try {
      await engine.execute(loopDocument, {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GraphDocumentValidationError);
    expect(
      (thrown as GraphDocumentValidationError).issues.some(
        (candidate) => candidate.code === "capability.loop-not-supported"
      )
    ).toBe(true);
  });

  it("positive capability conformance: core.loop.* built-in kinds declare the loop capability and accept loop configuration", async () => {
    const catalogue = freshCatalogue();
    await namedTestEngine(catalogue);
    await registerBuiltInGraphNodes(catalogue);
    const validator = new GraphWorkflowDocumentValidator({ catalogue });

    for (const kind of [
      "core.loop.foreach",
      "core.loop.while",
      "core.loop.until",
    ] as const) {
      expect((await catalogue.getManifest(kind)).capabilities).toEqual(
        expect.arrayContaining(["loop"])
      );
    }

    const validBody: GraphWorkflowDocument = {
      id: "loop-body",
      name: "loop-body",
      inputs: [],
      outputs: [],
      nodes: [],
      edges: [],
    };
    const loopDocument: GraphWorkflowDocument = {
      id: "foreach-empty-body-wf",
      name: "foreach-empty-body-wf",
      inputs: [documentPort("in")],
      outputs: [],
      nodes: [
        documentNode("loop1", "core.loop.foreach", {}, {
          loop: { body: validBody } as never,
        }),
      ],
      edges: [
        documentEdge("rin", ["workflow", "in"], ["node", "loop1", "items"]),
      ],
    };
    const validation = await validator.validate(loopDocument);
    expect(validation.valid).toBe(true);
    expect(validation.resolved?.nodeById.get("loop1")?.manifest.kind).toBe(
      "core.loop.foreach"
    );
  });
});
