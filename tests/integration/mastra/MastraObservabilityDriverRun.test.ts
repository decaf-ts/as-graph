/**
 * @module as-graph/tests/integration/mastra/MastraObservabilityDriverRun
 * @summary Driver tests for the mastra engine observability layer over a real
 * `@mastra/core` runtime (SAA-836 O1, SAA-891): the engine catches every
 * signal the run emits, the OUR-node isolation exporter attributes the
 * canonical nodes, and the runtime binding keeps the run under the runtime's
 * observability context.
 * @description Real-vs-injected note. **Real**: a real `Mastra` runtime backed
 * by a real `InMemoryStore`, the production `MastraGraphExecutionBackend`
 * (including its `wireMastraObservability` wiring and `bindCompiledWorkflow`
 * runtime registration), the production `MastraWorkflowCompiler`, the real
 * `@mastra/langfuse` `LangfuseExporter`, the real `@mastra/observability`
 * registry/instance, and the real run pipeline (`createRun`/`stream`). The
 * langfuse endpoint is pointed at an unreachable local URL so the OTLP
 * exporter never reaches langfuse cloud, and the langfuse credentials are
 * fake values (gate C only requires them to be present — no real secret is
 * ever used or logged). A recorder exporter is registered on the runtime's
 * default observability instance to observe the exported spans; the
 * OUR-node classification is exercised on those real exported spans through
 * a production `DecafNodeObservabilityExporter`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import {
  Observability,
  DefaultObservabilityInstance,
} from "@mastra/observability";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import {
  DecafNodeObservabilityExporter,
  type MastraExportedSpanLike,
} from "../../../src/mastra/MastraObservability";
import { GRAPH_MASTRA_OBSERVABILITY_CREDENTIALS_UNAVAILABLE } from "../../../src/mastra/MastraEnvironment";
import { GraphExecutionError } from "../../../src/engine/errors/GraphExecutionError";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GraphExecutionStatus } from "../../../src/shared/graph/constants";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { document, edge, node } from "../../../src/workflows/builders";
import { frameSinkHarness, realStepHandler } from "./helpers";

const NODE_KIND = "test.leaf";

/** The observability env variables this suite overrides (restored in afterAll). */
const ENV_OVERRIDES: Array<[string, string]> = [
  ["LANGFUSE_PUBLIC_KEY", "saa-891-fake-public-key"],
  ["LANGFUSE_SECRET_KEY", "saa-891-fake-secret-key"],
  ["MASTRA__OBSERVABILITY__LANGFUSE__ENDPOINT", "http://127.0.0.1:9"],
];

beforeAll(() => {
  for (const [name, value] of ENV_OVERRIDES) {
    process.env[name] = value;
  }
});

afterAll(() => {
  for (const [name] of ENV_OVERRIDES) {
    delete process.env[name];
  }
});

afterEach(() => {
  GraphExecutionBackendRegistry.clear();
});

/** The canonical two-leaf document executed by every driver run in this suite. */
function twoLeafDocument(): GraphWorkflowDocument {
  return document({
    id: "saa-891-observability-doc",
    name: "saa-891-observability-doc",
    nodes: [node("first", NODE_KIND), node("second", NODE_KIND)],
    edges: [edge("e1", ["node", "first", "out"], ["node", "second", "in"])],
  });
}

/** A recorded tracing event: mastra's export pipeline payload. */
interface RecordedSpanEvent {
  type: string;
  exportedSpan?: MastraExportedSpanLike;
}

/** A recorder exporter observing every tracing event the engine exports. */
function recorderExporter(): {
  name: string;
  events: RecordedSpanEvent[];
  onTracingEvent: (event: RecordedSpanEvent) => Promise<void>;
} {
  const events: RecordedSpanEvent[] = [];
  return {
    name: "saa-891-recorder",
    events,
    onTracingEvent: async (event) => {
      events.push(event);
    },
  };
}

/** Registers the recorder on the runtime's (now real) default observability
 * instance, mirroring how the backend registers its own exporters. */
function registerRecorder(runtime: Mastra, recorder: unknown): void {
  (
    runtime as unknown as Record<string, unknown>
  )["registerExporter"](
    recorder,
    new DefaultObservabilityInstance({
      name: "default",
      serviceName: "saa-891-recorder",
      exporters: [],
    }),
    new Observability({ configs: {} })
  );
}

/** The exported spans satisfying the predicate, one entry per event. */
function spansOf(
  events: RecordedSpanEvent[],
  predicate: (span: MastraExportedSpanLike) => boolean
): MastraExportedSpanLike[] {
  return events.flatMap((event) =>
    event.exportedSpan !== undefined && predicate(event.exportedSpan)
      ? [event.exportedSpan]
      : []
  );
}

/** The mastra step id encoded in a `workflow step: '<stepId>'` span name. */
function workflowStepIdOf(span: MastraExportedSpanLike): string {
  const match = /^workflow step: '(.+)'$/.exec(String(span.name));
  expect(match).not.toBeNull();
  return match![1];
}

describe("mastra observability driver run (SAA-836 O1, SAA-891)", () => {
  it("catches everything: the engine exports the workflow_run root span and every workflow step span to the runtime's default observability instance", async () => {
    const runtime = new Mastra({ storage: new InMemoryStore() });
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: runtime,
      stepHandlers: [realStepHandler(NODE_KIND)],
    });

    const recorder = recorderExporter();
    registerRecorder(runtime, recorder);

    const source = twoLeafDocument();
    const harness = frameSinkHarness("saa-891-observability-run");
    const result = await backend.execute({
      document: source,
      plan: {} as never,
      inputs: { in: 1 },
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);

    // The root span of the run: mastra names it after the bound workflow.
    const rootSpans = spansOf(
      recorder.events,
      (span) => span.name === `workflow run: '${source.id}'`
    );
    expect(rootSpans.length).toBeGreaterThanOrEqual(2);
    expect(
      rootSpans.every((span) => span.type === "workflow_run")
    ).toBe(true);

    // Every translated step's span is exported too.
    for (const nodeId of ["first", "second"]) {
      const stepSpans = spansOf(
        recorder.events,
        (span) => span.name === `workflow step: '${nodeId}'`
      );
      expect(stepSpans.length).toBeGreaterThanOrEqual(2);
      expect(
        stepSpans.every((span) => span.type === "workflow_step")
      ).toBe(true);
    }

    // Exactly one workflow_run span lifecycle for this simple run: the engine
    // caught the whole run, not fragments of it.
    expect(
      new Set(spansOf(recorder.events, (span) => span.type === "workflow_run").map((span) => span.id)).size
    ).toBe(1);
  }, 30000);

  it("isolates OUR nodes: the production exporter attributes the workflow step spans to their canonical nodes and keeps the root span engine-scoped", async () => {
    const runtime = new Mastra({ storage: new InMemoryStore() });
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: runtime,
      stepHandlers: [realStepHandler(NODE_KIND)],
    });

    const recorder = recorderExporter();
    registerRecorder(runtime, recorder);

    const source = twoLeafDocument();
    const harness = frameSinkHarness("saa-891-isolation-run");
    const result = await backend.execute({
      document: source,
      plan: {} as never,
      inputs: { in: 1 },
      options: {} as never,
      events: harness.sink,
    });
    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);

    // The production classifier, tracking the executed document's nodes the
    // same way the backend does on every run.
    const exporter = new DecafNodeObservabilityExporter();
    exporter.trackNodes(
      (source.nodes ?? []).map((graphNode) => ({
        id: graphNode.id,
        kind: graphNode.kind,
      }))
    );

    const stepSpans = spansOf(
      recorder.events,
      (span) => span.type === "workflow_step"
    );
    expect(stepSpans.length).toBeGreaterThanOrEqual(2);
    for (const span of stepSpans) {
      expect(exporter.originOf(span)).toEqual({
        id: workflowStepIdOf(span),
        kind: NODE_KIND,
      });
    }

    // The root span stays engine-scoped: no OUR-node origin.
    const rootSpans = spansOf(
      recorder.events,
      (span) => span.type === "workflow_run"
    );
    expect(rootSpans.length).toBeGreaterThanOrEqual(1);
    for (const span of rootSpans) {
      expect(exporter.originOf(span)).toBeUndefined();
    }
  }, 30000);

  it("binds the compiled workflow to the runtime so runs execute under the runtime's observability context (regression guard)", async () => {
    const runtime = new Mastra({ storage: new InMemoryStore() });
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: runtime,
      stepHandlers: [realStepHandler(NODE_KIND)],
    });
    const source = twoLeafDocument();
    const harness = frameSinkHarness("saa-891-binding-run");
    const result = await backend.execute({
      document: source,
      plan: {} as never,
      inputs: { in: 1 },
      options: {} as never,
      events: harness.sink,
    });
    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);

    // The compiled workflow is registered on the runtime under its canonical
    // id — the `bindCompiledWorkflow` path — so the run was created against
    // the runtime (and its observability context), not a detached workflow.
    const bound = (
      runtime as unknown as {
        getWorkflow: (id: string) => { id?: string } | undefined;
      }
    ).getWorkflow(source.id) as { id?: string } | undefined;
    expect(bound).toBeDefined();
    expect((bound as { id?: string }).id).toBe(source.id);
  }, 30000);

  it("fails closed at backend boot on a real runtime without langfuse credentials", async () => {
    const publicKey = process.env["LANGFUSE_PUBLIC_KEY"];
    const secretKey = process.env["LANGFUSE_SECRET_KEY"];
    delete process.env["LANGFUSE_PUBLIC_KEY"];
    delete process.env["LANGFUSE_SECRET_KEY"];
    try {
      const runtime = new Mastra({ storage: new InMemoryStore() });
      const backend = new MastraGraphExecutionBackend();
      let caught: unknown;
      try {
        await backend.initialize({
          mastra: runtime,
          stepHandlers: [realStepHandler(NODE_KIND)],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GraphExecutionError);
      expect((caught as { graphCode?: string }).graphCode).toBe(
        GRAPH_MASTRA_OBSERVABILITY_CREDENTIALS_UNAVAILABLE
      );
      expect(
        (caught as { details?: { credentialEnvs?: string[] } }).details
          ?.credentialEnvs
      ).toEqual(["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]);
    } finally {
      process.env["LANGFUSE_PUBLIC_KEY"] = publicKey;
      process.env["LANGFUSE_SECRET_KEY"] = secretKey;
    }
  }, 30000);
});
