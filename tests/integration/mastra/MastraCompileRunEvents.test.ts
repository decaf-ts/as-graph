/**
 * @module as-graph/tests/integration/mastra/MastraCompileRunEvents.test
 * @summary SAA-307 evidence: compile a canonical document into a real
 * `@mastra/core` workflow, run it, and bridge its real `fullStream` onto the
 * canonical event sink.
 * @description Real-vs-injected note. **Real**: `@mastra/core@1.74` workflow
 * construction (`createStep`/`createWorkflow`/`commit`), run creation
 * (`createRun`/`stream`/`fullStream`/`result`), the production
 * `MastraWorkflowCompiler` and `MastraEventBridge`, and the production
 * `GraphExecutionEngine` facade. **Host-injected**: the frame-bound event sink
 * (the engine normally creates it) and the Mastra `stepHandlers` (the host owns
 * `createStep` translation). The assertions observe the real run by its real
 * events and by the real step side-effects, never by a stub.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { Workflow } from "@mastra/core/workflows";
import { GraphExecutionEventType, GraphExecutionStatus } from "../../../src/shared/graph/constants";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { MastraEventBridge } from "../../../src/mastra/MastraEventBridge";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { bootEngine, demoCatalogue } from "../../unit/graph/engine-fixtures";
import type { GraphExecutionObserver } from "../../../src/engine/events/GraphExecutionObserver";
import {
  compileDocument,
  frameSinkHarness,
  integrationTwoLeafDocument,
  realStepHandler,
  type StepCall,
} from "./helpers";

const NODE_KIND = "test.leaf";

/** The real Mastra step ids observed for the two-leaf document, in order. */
function stepIds(calls: StepCall[]): string[] {
  return calls.map((call) => call.stepId);
}

describe("Mastra compile -> real run -> bridge (SAA-307 item 1)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("compiles a canonical document into a real committed Mastra workflow", () => {
    const source = integrationTwoLeafDocument();
    const { compiler, compiled } = compileDocument(source, [
      realStepHandler(NODE_KIND),
    ]);

    expect(compiled.workflowId).toBe(source.id);
    expect(compiled.workflow).toBeInstanceOf(Workflow);
    expect((compiled.workflow as { id: string }).id).toBe(source.id);
    expect(typeof (compiled.workflow as { createRun: unknown }).createRun).toBe(
      "function"
    );
    expect([...compiled.steps.keys()]).toEqual(["first", "second"]);
    for (const [nodeId, step] of compiled.steps) {
      expect((step as { id: string }).id).toBe(nodeId);
      expect(typeof (step as { execute: unknown }).execute).toBe("function");
    }
    // The leaf nodes declare no `outputSchema`, so their schemas degrade.
    expect(compiled.degradedSchemas).toEqual(["first", "second"]);
    expect(compiler.get(source)).toBe(compiled);
  });

  it("bridges a real fullStream onto a frame-bound sink and observers", async () => {
    const source = integrationTwoLeafDocument();
    const calls: StepCall[] = [];
    const { compiled } = compileDocument(source, [
      realStepHandler(NODE_KIND, undefined, calls),
    ]);
    const harness = frameSinkHarness("mastra-it-bridge");
    const bridge = new MastraEventBridge({
      runId: "mastra-it-bridge",
      workflowId: source.id,
      document: source,
      sink: harness.sink,
    });

    const run = await (
      compiled.workflow as {
        createRun: (options?: unknown) => Promise<{
          stream: (options?: unknown) => Promise<{
            fullStream: AsyncIterable<Record<string, unknown>>;
            result?: Promise<unknown>;
          }>;
        }>;
      }
    ).createRun({ runId: "mastra-it-bridge" });
    const stream = await run.stream({ inputData: { in: 1 } });

    await bridge.attach(stream.fullStream);
    await stream.result;

    expect(stepIds(calls)).toEqual(["first", "second"]);
    expect(calls[1].inputData).toEqual({ out: { in: 1 } });

    const types = harness.events.map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        GraphExecutionEventType.WORKFLOW_STARTED,
        GraphExecutionEventType.NODE_STARTED,
        GraphExecutionEventType.NODE_COMPLETED,
        GraphExecutionEventType.EDGE_VALUE_ROUTED,
        GraphExecutionEventType.WORKFLOW_COMPLETED,
      ])
    );

    const firstCompleted = harness.events.find(
      (event) =>
        event.type === GraphExecutionEventType.NODE_COMPLETED &&
        event.nodeId === "first"
    );
    expect(firstCompleted?.payload).toEqual({ outputs: { out: { in: 1 } } });
    const routed = harness.events.find(
      (event) => event.type === GraphExecutionEventType.EDGE_VALUE_ROUTED
    );
    expect(routed?.edgeId).toBe("e1");

    expect(harness.observed).toHaveLength(harness.events.length);
    expect(harness.observed.map((event) => event.type)).toEqual(types);
  });

  it("drives the whole engine end-to-end through the real Mastra backend", async () => {
    const source: GraphWorkflowDocument = integrationTwoLeafDocument();
    const calls: StepCall[] = [];
    const catalogue = await demoCatalogue({ [NODE_KIND]: { execute: () => ({}) } });
    const backend = new MastraGraphExecutionBackend();
    // The host wires the backend's Mastra collaborators before booting the
    // engine; `GraphExecutionEngine.initialize` must preserve them (SAA-312).
    await backend.initialize({
      mastra: {},
      stepHandlers: [realStepHandler(NODE_KIND, undefined, calls)],
    });
    const engine = await bootEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
      catalogue,
      backend,
    });

    const observed: string[] = [];
    const observer: GraphExecutionObserver = {
      refresh: async (event) => {
        observed.push(event.type);
      },
    };
    engine.observe(observer);

    const result = await engine.execute(
      source,
      { in: 1 },
      { runId: "mastra-it-engine-run" }
    );

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(stepIds(calls)).toEqual(["first", "second"]);

    const requiredTypes = [
      GraphExecutionEventType.WORKFLOW_STARTED,
      GraphExecutionEventType.NODE_STARTED,
      GraphExecutionEventType.NODE_COMPLETED,
      GraphExecutionEventType.EDGE_VALUE_ROUTED,
      GraphExecutionEventType.WORKFLOW_COMPLETED,
    ];
    const resultTypes = result.events.map((event) => event.type);
    expect(resultTypes).toEqual(expect.arrayContaining(requiredTypes));
    // The observer sees every event the facade emits, including the validation
    // events emitted before the frame is bound (which `result.events` omits).
    expect(observed).toEqual(expect.arrayContaining(requiredTypes));
    expect(observed).toEqual(expect.arrayContaining(resultTypes));
    expect(observed.length).toBeGreaterThanOrEqual(result.events.length);
    expect(engine.backend).toBe(backend);
  });
});
